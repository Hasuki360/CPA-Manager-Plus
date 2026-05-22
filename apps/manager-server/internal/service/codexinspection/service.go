package codexinspection

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	codexUsageURL       = "https://chatgpt.com/backend-api/wham/usage"
	codexFiveHourWindow = 18_000
	codexWeekWindow     = 604_800
	maxStoredBodyText   = 2048
)

var (
	ErrRunAlreadyActive = errors.New("codex inspection is already running")
	ErrNotConfigured    = errors.New("usage service is not configured")
	ErrRunNotFound      = errors.New("codex inspection run not found")
)

type Service struct {
	store                *store.Store
	managerConfigService *managerconfig.Service
	client               *http.Client

	mu      sync.Mutex
	running bool
}

type RunRequest struct {
	TriggerType string
	TriggerKey  string
}

type RunDetail struct {
	Run     model.CodexInspectionRun      `json:"run"`
	Results []model.CodexInspectionResult `json:"results"`
	Logs    []model.CodexInspectionLog    `json:"logs"`
}

type authFile map[string]any

type account struct {
	Key            string
	FileName       string
	DisplayAccount string
	AuthIndex      string
	AccountID      string
	Provider       string
	Disabled       bool
	Status         string
	State          string
	File           authFile
}

type apiCallResponse struct {
	StatusCode    int
	HasStatusCode bool
	BodyText      string
	Body          any
}

type inspectionDecision struct {
	Action       string
	ActionReason string
	UsedPercent  *float64
	IsQuota      bool
}

type codexRateLimit struct {
	Allowed         *bool
	LimitReached    bool
	PrimaryWindow   *codexWindow
	SecondaryWindow *codexWindow
}

type codexWindow struct {
	UsedPercent        *float64
	LimitWindowSeconds *float64
}

func New(st *store.Store, managerConfigService *managerconfig.Service, clients ...*http.Client) *Service {
	client := &http.Client{Timeout: 30 * time.Second}
	if len(clients) > 0 && clients[0] != nil {
		client = clients[0]
	}
	return &Service{
		store:                st,
		managerConfigService: managerConfigService,
		client:               client,
	}
}

func (s *Service) Run(ctx context.Context, req RunRequest) (RunDetail, error) {
	if err := s.acquireRun(); err != nil {
		return RunDetail{}, err
	}
	defer s.releaseRun()

	settings, setup, err := s.resolveRuntime(ctx)
	if err != nil {
		return RunDetail{}, err
	}

	triggerType := strings.TrimSpace(req.TriggerType)
	if triggerType == "" {
		triggerType = model.CodexInspectionTriggerManual
	}
	startedAt := time.Now().UnixMilli()
	run, err := s.store.CreateCodexInspectionRun(ctx, model.CodexInspectionRun{
		TriggerType:  triggerType,
		TriggerKey:   strings.TrimSpace(req.TriggerKey),
		Status:       model.CodexInspectionStatusRunning,
		StartedAtMS:  startedAt,
		Settings:     settings,
		SettingsJSON: model.MarshalCodexInspectionSettings(settings),
	})
	if err != nil {
		return RunDetail{}, err
	}
	persistCtx := context.WithoutCancel(ctx)

	logger := runLogger{service: s, runID: run.ID}
	logger.info(ctx, "Codex 巡检开始", map[string]any{
		"triggerType": triggerType,
		"triggerKey":  strings.TrimSpace(req.TriggerKey),
		"targetType":  settings.TargetType,
	})

	files, err := s.fetchAuthFiles(ctx, setup)
	if err != nil {
		logger.error(persistCtx, "加载认证文件列表失败", map[string]any{"error": err.Error()})
		return s.failRun(persistCtx, run, err)
	}

	accounts := make([]account, 0, len(files))
	for _, file := range files {
		next := toAccount(file)
		if next.Provider == settings.TargetType {
			accounts = append(accounts, next)
		}
	}
	probeSetCount := len(accounts)
	sampled := pickSample(accounts, settings.SampleSize)

	run.TotalFiles = len(files)
	run.ProbeSetCount = probeSetCount
	run.SampledCount = len(sampled)
	run.DisabledCount = countAccounts(sampled, true)
	run.EnabledCount = len(sampled) - run.DisabledCount
	_ = s.store.UpdateCodexInspectionRun(persistCtx, run)

	logger.info(ctx, "Codex 巡检集合已准备", map[string]any{
		"totalFiles":    len(files),
		"probeSetCount": probeSetCount,
		"sampledCount":  len(sampled),
	})

	results := s.inspectAccounts(ctx, setup, settings, run.ID, sampled, logger)
	results = resolveAutoActionResults(settings.AutoActionMode, results)
	actionErrors := s.executeActions(ctx, setup, settings, results, logger)
	results = annotateActionErrors(results, actionErrors)
	for _, result := range results {
		result.RunID = run.ID
		_, _ = s.store.InsertCodexInspectionResult(persistCtx, result)
	}
	run = summarizeRun(run, results)
	if len(actionErrors) > 0 {
		run.Error = fmt.Sprintf("%d 个自动处理动作执行失败，详见巡检日志", len(actionErrors))
	}
	run.Status = model.CodexInspectionStatusCompleted
	run.FinishedAtMS = time.Now().UnixMilli()
	if err := s.store.UpdateCodexInspectionRun(persistCtx, run); err != nil {
		return RunDetail{}, err
	}
	logger.success(persistCtx, "Codex 巡检完成", map[string]any{
		"deleteCount":  run.DeleteCount,
		"disableCount": run.DisableCount,
		"enableCount":  run.EnableCount,
		"keepCount":    run.KeepCount,
		"actionErrors": actionErrors,
	})
	return s.GetRun(persistCtx, run.ID)
}

func (s *Service) ListRuns(ctx context.Context, limit int) ([]model.CodexInspectionRun, error) {
	return s.store.ListCodexInspectionRuns(ctx, limit)
}

func (s *Service) GetRun(ctx context.Context, id int64) (RunDetail, error) {
	run, ok, err := s.store.GetCodexInspectionRun(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	if !ok {
		return RunDetail{}, ErrRunNotFound
	}
	results, err := s.store.ListCodexInspectionResults(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	logs, err := s.store.ListCodexInspectionLogs(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	return RunDetail{Run: run, Results: results, Logs: logs}, nil
}

func (s *Service) ResolveConfig(ctx context.Context) (model.ManagerCodexInspectionConfig, bool, error) {
	managerCfg, _, ok, err := s.managerConfigService.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return model.ManagerCodexInspectionConfig{}, false, err
	}
	if !ok || strings.TrimSpace(managerCfg.CPAConnection.CPABaseURL) == "" ||
		strings.TrimSpace(managerCfg.CPAConnection.ManagementKey) == "" {
		return model.DefaultCodexInspectionConfig(), false, nil
	}
	return model.NormalizeCodexInspectionConfig(
		managerCfg.CodexInspection,
		model.DefaultCodexInspectionConfig(),
	), true, nil
}

func (s *Service) acquireRun() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return ErrRunAlreadyActive
	}
	s.running = true
	return nil
}

func (s *Service) releaseRun() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
}

func (s *Service) resolveRuntime(ctx context.Context) (model.ManagerCodexInspectionConfig, store.Setup, error) {
	managerCfg, _, ok, err := s.managerConfigService.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return model.ManagerCodexInspectionConfig{}, store.Setup{}, err
	}
	if !ok || strings.TrimSpace(managerCfg.CPAConnection.CPABaseURL) == "" ||
		strings.TrimSpace(managerCfg.CPAConnection.ManagementKey) == "" {
		return model.ManagerCodexInspectionConfig{}, store.Setup{}, ErrNotConfigured
	}
	settings := model.NormalizeCodexInspectionConfig(
		managerCfg.CodexInspection,
		model.DefaultCodexInspectionConfig(),
	)
	return settings, managerconfig.SetupFromManagerConfig(managerCfg), nil
}

func (s *Service) failRun(ctx context.Context, run model.CodexInspectionRun, cause error) (RunDetail, error) {
	run.Status = model.CodexInspectionStatusFailed
	run.Error = cause.Error()
	run.FinishedAtMS = time.Now().UnixMilli()
	_ = s.store.UpdateCodexInspectionRun(ctx, run)
	detail, err := s.GetRun(ctx, run.ID)
	if err != nil {
		return RunDetail{}, err
	}
	return detail, cause
}

func (s *Service) fetchAuthFiles(ctx context.Context, setup store.Setup) ([]authFile, error) {
	files, status, err := s.fetchAuthFilesAt(ctx, setup, "/auth-files")
	if err == nil {
		return files, nil
	}
	if status == http.StatusNotFound || status == http.StatusMethodNotAllowed {
		files, _, err := s.fetchAuthFilesAt(ctx, setup, "/v0/management/auth-files")
		return files, err
	}
	return nil, err
}

func (s *Service) fetchAuthFilesAt(ctx context.Context, setup store.Setup, path string) ([]authFile, int, error) {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+path,
		nil,
	)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, res.StatusCode, fmt.Errorf("auth files request failed: %s %s", res.Status, truncate(string(body), maxStoredBodyText))
	}
	var payload struct {
		Files []authFile `json:"files"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, res.StatusCode, err
	}
	return payload.Files, res.StatusCode, nil
}

func (s *Service) inspectAccounts(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerCodexInspectionConfig,
	runID int64,
	accounts []account,
	logger runLogger,
) []model.CodexInspectionResult {
	if len(accounts) == 0 {
		return nil
	}
	workers := settings.Workers
	if workers <= 0 {
		workers = 1
	}

	jobs := make(chan account)
	results := make(chan model.CodexInspectionResult, len(accounts))
	var wg sync.WaitGroup
	for i := 0; i < workers && i < len(accounts); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				result := s.inspectSingleAccount(ctx, setup, settings, item, logger)
				result.RunID = runID
				if _, err := s.store.InsertCodexInspectionResult(ctx, result); err != nil {
					logger.error(ctx, "写入巡检账号结果失败", map[string]any{
						"fileName": item.FileName,
						"error":    err.Error(),
					})
				}
				results <- result
			}
		}()
	}

	go func() {
		defer close(jobs)
		for _, item := range accounts {
			select {
			case <-ctx.Done():
				return
			case jobs <- item:
			}
		}
	}()

	wg.Wait()
	close(results)

	out := make([]model.CodexInspectionResult, 0, len(accounts))
	for result := range results {
		out = append(out, result)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FileName == out[j].FileName {
			return out[i].DisplayAccount < out[j].DisplayAccount
		}
		return out[i].FileName < out[j].FileName
	})
	return out
}

func (s *Service) inspectSingleAccount(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerCodexInspectionConfig,
	item account,
	logger runLogger,
) model.CodexInspectionResult {
	base := resultFromAccount(item)
	if item.AuthIndex == "" {
		base.Action = "keep"
		base.ActionReason = "缺少 auth_index，保留账号"
		base.Error = "缺少 auth_index"
		logger.warning(ctx, "账号缺少 auth_index，跳过探测", map[string]any{
			"fileName":       item.FileName,
			"displayAccount": item.DisplayAccount,
		})
		return base
	}

	var response apiCallResponse
	var err error
	for attempt := 0; attempt <= settings.Retries; attempt++ {
		response, err = s.requestCodexUsage(ctx, setup, settings, item)
		if err == nil {
			break
		}
	}
	if err != nil {
		base.Action = "keep"
		base.ActionReason = "探测异常，保留账号"
		base.Error = err.Error()
		logger.warning(ctx, "账号探测异常，保留账号", map[string]any{
			"fileName":       item.FileName,
			"displayAccount": item.DisplayAccount,
			"error":          err.Error(),
		})
		return base
	}
	if !response.HasStatusCode {
		base.Action = "keep"
		base.ActionReason = "探测响应缺少 status_code，保留账号"
		base.Error = "响应缺少 status_code"
		logger.warning(ctx, "账号探测未返回 status_code，保留账号", map[string]any{
			"fileName":       item.FileName,
			"displayAccount": item.DisplayAccount,
			"body":           truncate(response.BodyText, maxStoredBodyText),
		})
		return base
	}

	statusCode := response.StatusCode
	base.StatusCode = &statusCode
	payload := parseRecord(response.Body)
	if payload == nil {
		payload = parseRecord(response.BodyText)
	}
	rateLimit := parseRateLimit(readMap(payload, "rate_limit", "rateLimit"))
	usedPercent := deriveRateLimitUsedPercent(rateLimit)
	bodyLower := strings.ToLower(response.BodyText)
	isQuota := statusCode == http.StatusPaymentRequired ||
		strings.Contains(bodyLower, "quota exhausted") ||
		strings.Contains(bodyLower, "limit reached") ||
		strings.Contains(bodyLower, "payment_required") ||
		isRateLimitReached(rateLimit) ||
		(usedPercent != nil && *usedPercent >= settings.UsedPercentThreshold)
	decision := resolveProbeAction(item, statusCode, rateLimit, usedPercent, isQuota, settings.UsedPercentThreshold)

	base.Action = decision.Action
	base.ActionReason = decision.ActionReason
	base.UsedPercent = decision.UsedPercent
	base.IsQuota = decision.IsQuota
	base.Error = ""

	level := "info"
	switch decision.Action {
	case "delete":
		level = "error"
	case "disable":
		level = "warning"
	case "enable":
		level = "success"
	}
	logger.log(ctx, level, "账号探测完成", map[string]any{
		"fileName":       item.FileName,
		"displayAccount": item.DisplayAccount,
		"action":         decision.Action,
		"statusCode":     statusCode,
		"usedPercent":    nullableFloat(decision.UsedPercent),
		"isQuota":        decision.IsQuota,
	})
	return base
}

func (s *Service) requestCodexUsage(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerCodexInspectionConfig,
	item account,
) (apiCallResponse, error) {
	result, status, err := s.requestCodexUsageAt(ctx, setup, settings, item, "/api-call")
	if err == nil {
		return result, nil
	}
	if status == http.StatusNotFound || status == http.StatusMethodNotAllowed {
		result, _, err := s.requestCodexUsageAt(ctx, setup, settings, item, "/v0/management/api-call")
		return result, err
	}
	return apiCallResponse{}, err
}

func (s *Service) requestCodexUsageAt(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerCodexInspectionConfig,
	item account,
	path string,
) (apiCallResponse, int, error) {
	headers := map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type":  "application/json",
		"User-Agent":    settings.UserAgent,
	}
	if strings.TrimSpace(item.AccountID) != "" {
		headers["Chatgpt-Account-Id"] = strings.TrimSpace(item.AccountID)
	}
	payload := map[string]any{
		"authIndex": item.AuthIndex,
		"method":    http.MethodGet,
		"url":       codexUsageURL,
		"header":    headers,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return apiCallResponse{}, 0, err
	}
	requestCtx := ctx
	cancel := func() {}
	if settings.Timeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, time.Duration(settings.Timeout)*time.Millisecond)
	}
	defer cancel()

	req, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+path,
		bytes.NewReader(data),
	)
	if err != nil {
		return apiCallResponse{}, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return apiCallResponse{}, 0, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return apiCallResponse{}, res.StatusCode, fmt.Errorf("api-call failed: %s %s", res.Status, truncate(string(body), maxStoredBodyText))
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return apiCallResponse{}, res.StatusCode, err
	}
	statusRaw, hasStatus := firstValue(raw, "status_code", "statusCode")
	statusCode := int(readFloat(statusRaw, 0))
	bodyRaw, _ := firstValue(raw, "body")
	bodyText, bodyValue := normalizeBody(bodyRaw)
	return apiCallResponse{
		StatusCode:    statusCode,
		HasStatusCode: hasStatus && strings.TrimSpace(fmt.Sprint(statusRaw)) != "",
		BodyText:      bodyText,
		Body:          bodyValue,
	}, res.StatusCode, nil
}

func (s *Service) executeActions(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerCodexInspectionConfig,
	results []model.CodexInspectionResult,
	logger runLogger,
) map[string]string {
	items := dedupeActionItems(results)
	if len(items) == 0 || settings.AutoActionMode == model.CodexInspectionAutoActionNone {
		return map[string]string{}
	}
	workers := settings.DeleteWorkers
	if workers <= 0 {
		workers = 1
	}
	jobs := make(chan model.CodexInspectionResult)
	var wg sync.WaitGroup
	var mu sync.Mutex
	failures := map[string]string{}
	for i := 0; i < workers && i < len(items); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				if err := s.executeAction(ctx, setup, item); err != nil {
					mu.Lock()
					failures[item.AccountKey] = err.Error()
					mu.Unlock()
					logger.error(ctx, "自动处理账号失败", map[string]any{
						"fileName":       item.FileName,
						"displayAccount": item.DisplayAccount,
						"action":         item.Action,
						"error":          err.Error(),
					})
					continue
				}
				logger.success(ctx, "自动处理账号成功", map[string]any{
					"fileName":       item.FileName,
					"displayAccount": item.DisplayAccount,
					"action":         item.Action,
				})
			}
		}()
	}
	for _, item := range items {
		jobs <- item
	}
	close(jobs)
	wg.Wait()
	return failures
}

func (s *Service) executeAction(ctx context.Context, setup store.Setup, item model.CodexInspectionResult) error {
	switch item.Action {
	case "delete":
		if err, status := s.deleteAuthFile(ctx, setup, "/auth-files", item.FileName); err != nil {
			if shouldFallbackManagement(status) {
				return s.deleteAuthFileOnly(ctx, setup, "/v0/management/auth-files", item.FileName)
			}
			return err
		}
		return nil
	case "disable", "enable":
		disabled := item.Action == "disable"
		payload := map[string]any{"name": item.FileName, "disabled": disabled}
		if err, status := s.patchAuthFile(ctx, setup, "/auth-files", payload); err != nil {
			if statusErr, statusCode := s.patchAuthFile(ctx, setup, "/auth-files/status", payload); statusErr == nil {
				return nil
			} else if shouldFallbackManagement(status) && shouldFallbackManagement(statusCode) {
				if err := s.patchAuthFileOnly(ctx, setup, "/v0/management/auth-files", payload); err != nil {
					return s.patchAuthFileOnly(ctx, setup, "/v0/management/auth-files/status", payload)
				}
				return nil
			} else {
				return statusErr
			}
		}
		return nil
	default:
		return nil
	}
}

func (s *Service) deleteAuthFileOnly(ctx context.Context, setup store.Setup, path string, fileName string) error {
	err, _ := s.deleteAuthFile(ctx, setup, path, fileName)
	return err
}

func (s *Service) deleteAuthFile(ctx context.Context, setup store.Setup, path string, fileName string) (error, int) {
	endpoint := cpa.NormalizeBaseURL(setup.CPAUpstreamURL) + path + "?name=" + url.QueryEscape(fileName)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err, 0
	}
	return s.doCPAAction(req, setup.ManagementKey)
}

func (s *Service) patchAuthFileOnly(ctx context.Context, setup store.Setup, path string, payload map[string]any) error {
	err, _ := s.patchAuthFile(ctx, setup, path, payload)
	return err
}

func (s *Service) patchAuthFile(ctx context.Context, setup store.Setup, path string, payload map[string]any) (error, int) {
	data, err := json.Marshal(payload)
	if err != nil {
		return err, 0
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPatch,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+path,
		bytes.NewReader(data),
	)
	if err != nil {
		return err, 0
	}
	req.Header.Set("Content-Type", "application/json")
	return s.doCPAAction(req, setup.ManagementKey)
}

func (s *Service) doCPAAction(req *http.Request, managementKey string) (error, int) {
	req.Header.Set("Authorization", "Bearer "+managementKey)
	res, err := s.client.Do(req)
	if err != nil {
		return err, 0
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s", res.Status, truncate(string(body), maxStoredBodyText)), res.StatusCode
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err == nil {
		if failed, ok := payload["failed"].([]any); ok && len(failed) > 0 {
			return fmt.Errorf("CPA action failed: %s", truncate(fmt.Sprint(failed[0]), maxStoredBodyText)), res.StatusCode
		}
	}
	return nil, res.StatusCode
}

func shouldFallbackManagement(status int) bool {
	return status == http.StatusNotFound || status == http.StatusMethodNotAllowed
}

type runLogger struct {
	service *Service
	runID   int64
}

func (l runLogger) info(ctx context.Context, message string, detail any) {
	l.log(ctx, "info", message, detail)
}

func (l runLogger) success(ctx context.Context, message string, detail any) {
	l.log(ctx, "success", message, detail)
}

func (l runLogger) warning(ctx context.Context, message string, detail any) {
	l.log(ctx, "warning", message, detail)
}

func (l runLogger) error(ctx context.Context, message string, detail any) {
	l.log(ctx, "error", message, detail)
}

func (l runLogger) log(ctx context.Context, level string, message string, detail any) {
	if l.service == nil || l.runID <= 0 {
		return
	}
	_, _ = l.service.store.InsertCodexInspectionLog(ctx, model.CodexInspectionLog{
		RunID:   l.runID,
		Level:   level,
		Message: message,
		Detail:  sanitizeDetail(detail),
	})
}

func resolveProbeAction(item account, statusCode int, rateLimit *codexRateLimit, usedPercent *float64, isQuota bool, threshold float64) inspectionDecision {
	if decision := resolveWindowAwareProbeAction(item, statusCode, rateLimit, threshold); decision != nil {
		return *decision
	}
	return resolveLegacyProbeAction(item, statusCode, usedPercent, isQuota, threshold)
}

func resolveWindowAwareProbeAction(item account, statusCode int, rateLimit *codexRateLimit, threshold float64) *inspectionDecision {
	if rateLimit == nil {
		return nil
	}
	_, weekly := classifyWindows(rateLimit)
	if weekly == nil || weekly.UsedPercent == nil {
		return nil
	}
	weeklyUsedPercent := *weekly.UsedPercent
	fiveHour, _ := classifyWindows(rateLimit)
	fiveHourOverThreshold := fiveHour != nil && fiveHour.UsedPercent != nil && *fiveHour.UsedPercent >= threshold

	if statusCode == http.StatusUnauthorized {
		return &inspectionDecision{
			Action:       "delete",
			ActionReason: "接口返回 401，建议删除失效账号",
			UsedPercent:  ptrFloat(weeklyUsedPercent),
			IsQuota:      false,
		}
	}
	if weeklyUsedPercent >= threshold {
		if item.Disabled {
			return &inspectionDecision{
				Action:       "keep",
				ActionReason: "周额度达到阈值，但账号已禁用",
				UsedPercent:  ptrFloat(weeklyUsedPercent),
				IsQuota:      true,
			}
		}
		return &inspectionDecision{
			Action:       "disable",
			ActionReason: "周额度达到阈值，建议禁用账号",
			UsedPercent:  ptrFloat(weeklyUsedPercent),
			IsQuota:      true,
		}
	}
	if item.Disabled {
		reason := "周额度仍可用，建议立即启用账号"
		if fiveHourOverThreshold {
			reason = "5 小时额度达到阈值，但周额度仍可用，建议立即启用账号"
		}
		return &inspectionDecision{
			Action:       "enable",
			ActionReason: reason,
			UsedPercent:  ptrFloat(weeklyUsedPercent),
			IsQuota:      false,
		}
	}
	if fiveHourOverThreshold {
		return &inspectionDecision{
			Action:       "keep",
			ActionReason: "5 小时额度达到阈值，但周额度仍可用，暂不禁用账号",
			UsedPercent:  ptrFloat(weeklyUsedPercent),
			IsQuota:      false,
		}
	}
	return &inspectionDecision{
		Action:       "keep",
		ActionReason: "周额度仍可用，无需处理",
		UsedPercent:  ptrFloat(weeklyUsedPercent),
		IsQuota:      false,
	}
}

func resolveLegacyProbeAction(item account, statusCode int, usedPercent *float64, isQuota bool, threshold float64) inspectionDecision {
	overThreshold := usedPercent != nil && *usedPercent >= threshold
	if statusCode == http.StatusUnauthorized {
		return inspectionDecision{
			Action:       "delete",
			ActionReason: "接口返回 401，建议删除失效账号",
			UsedPercent:  usedPercent,
			IsQuota:      false,
		}
	}
	if isQuota || overThreshold {
		if item.Disabled {
			reason := "额度已耗尽，但账号已禁用"
			if overThreshold {
				reason = "额度超阈值，但账号已禁用"
			}
			return inspectionDecision{Action: "keep", ActionReason: reason, UsedPercent: usedPercent, IsQuota: isQuota}
		}
		reason := "额度已耗尽，建议禁用账号"
		if overThreshold {
			reason = "额度超阈值，建议禁用账号"
		}
		return inspectionDecision{Action: "disable", ActionReason: reason, UsedPercent: usedPercent, IsQuota: isQuota}
	}
	if statusCode == http.StatusOK && item.Disabled {
		return inspectionDecision{
			Action:       "enable",
			ActionReason: "账号恢复健康，建议重新启用",
			UsedPercent:  usedPercent,
			IsQuota:      false,
		}
	}
	return inspectionDecision{Action: "keep", ActionReason: "无需处理", UsedPercent: usedPercent, IsQuota: false}
}

func resolveAutoActionResults(mode string, results []model.CodexInspectionResult) []model.CodexInspectionResult {
	mode = model.NormalizeCodexInspectionAutoActionMode(mode, model.CodexInspectionAutoActionNone)
	if mode == model.CodexInspectionAutoActionNone {
		return results
	}
	out := make([]model.CodexInspectionResult, len(results))
	copy(out, results)
	for i := range out {
		if mode == model.CodexInspectionAutoActionDisable && out[i].Action == "delete" {
			out[i].Action = "disable"
			if strings.TrimSpace(out[i].ActionReason) != "" {
				out[i].ActionReason += "；自动禁用策略改为禁用账号"
			} else {
				out[i].ActionReason = "自动禁用策略改为禁用账号"
			}
		}
	}
	return out
}

func dedupeActionItems(results []model.CodexInspectionResult) []model.CodexInspectionResult {
	seen := map[string]model.CodexInspectionResult{}
	for _, result := range results {
		if result.Action == "keep" || result.Action == "enable" || result.FileName == "" {
			continue
		}
		if _, ok := seen[result.FileName]; ok {
			continue
		}
		seen[result.FileName] = result
	}
	items := make([]model.CodexInspectionResult, 0, len(seen))
	for _, item := range seen {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].FileName < items[j].FileName })
	return items
}

func summarizeRun(run model.CodexInspectionRun, results []model.CodexInspectionResult) model.CodexInspectionRun {
	run.DeleteCount = 0
	run.DisableCount = 0
	run.EnableCount = 0
	run.KeepCount = 0
	for _, result := range results {
		switch result.Action {
		case "delete":
			run.DeleteCount++
		case "disable":
			run.DisableCount++
		case "enable":
			run.EnableCount++
		default:
			run.KeepCount++
		}
	}
	return run
}

func annotateActionErrors(results []model.CodexInspectionResult, actionErrors map[string]string) []model.CodexInspectionResult {
	if len(actionErrors) == 0 {
		return results
	}
	out := make([]model.CodexInspectionResult, len(results))
	copy(out, results)
	for i := range out {
		if errText, ok := actionErrors[out[i].AccountKey]; ok {
			out[i].Error = errText
		}
	}
	return out
}

func resultFromAccount(item account) model.CodexInspectionResult {
	return model.CodexInspectionResult{
		AccountKey:     item.Key,
		FileName:       item.FileName,
		DisplayAccount: item.DisplayAccount,
		AuthIndex:      item.AuthIndex,
		AccountID:      item.AccountID,
		Provider:       item.Provider,
		Disabled:       item.Disabled,
		Status:         item.Status,
		State:          item.State,
		Action:         "keep",
		ActionReason:   "无需处理",
		IsQuota:        false,
	}
}

func pickSample(items []account, sampleSize int) []account {
	if sampleSize <= 0 || sampleSize >= len(items) {
		out := make([]account, len(items))
		copy(out, items)
		return out
	}
	out := make([]account, len(items))
	copy(out, items)
	rand.Shuffle(len(out), func(i, j int) {
		out[i], out[j] = out[j], out[i]
	})
	return out[:sampleSize]
}

func countAccounts(items []account, disabled bool) int {
	count := 0
	for _, item := range items {
		if item.Disabled == disabled {
			count++
		}
	}
	return count
}

func toAccount(file authFile) account {
	fileName := firstNonEmpty(readString(file, "name"), readString(file, "id"), normalizeAuthIndex(file["auth_index"]), normalizeAuthIndex(file["authIndex"]), "unknown-auth-file")
	authIndex := firstNonEmpty(normalizeAuthIndex(file["auth_index"]), normalizeAuthIndex(file["authIndex"]), normalizeAuthIndex(file["auth-index"]))
	provider := strings.ToLower(firstNonEmpty(readString(file, "provider"), readString(file, "type"), readString(file, "typo")))
	displayAccount := firstNonEmpty(
		readString(file, "account"),
		readString(file, "email"),
		readString(file, "label"),
		fileName,
	)
	key := fileName + "::" + authIndex
	if authIndex == "" {
		key = fileName + "::-"
	}
	return account{
		Key:            key,
		FileName:       fileName,
		DisplayAccount: displayAccount,
		AuthIndex:      authIndex,
		AccountID:      resolveCodexAccountID(file),
		Provider:       provider,
		Disabled:       isDisabledAuthFile(file),
		Status:         readString(file, "status"),
		State:          readString(file, "state"),
		File:           file,
	}
}

func resolveCodexAccountID(file authFile) string {
	metadata := readMap(file, "metadata")
	attributes := readMap(file, "attributes")
	candidates := []any{
		file["chatgpt_account_id"],
		file["chatgptAccountId"],
		file["account_id"],
		file["accountId"],
		metadata["chatgpt_account_id"],
		metadata["chatgptAccountId"],
		metadata["account_id"],
		metadata["accountId"],
		attributes["chatgpt_account_id"],
		attributes["chatgptAccountId"],
		attributes["account_id"],
		attributes["accountId"],
	}
	for _, candidate := range candidates {
		if id := extractDirectCodexAccountID(candidate); id != "" {
			return id
		}
	}
	tokenCandidates := []any{
		file["id_token"],
		metadata["id_token"],
		attributes["id_token"],
	}
	for _, candidate := range tokenCandidates {
		if id := extractCodexAccountIDFromToken(candidate); id != "" {
			return id
		}
	}
	return ""
}

func extractDirectCodexAccountID(value any) string {
	if direct := readPlainString(value); direct != "" {
		return direct
	}
	if direct := readAccountIDCandidate(value); direct != "" {
		return direct
	}
	return ""
}

func extractCodexAccountIDFromToken(value any) string {
	payload := parseIDTokenPayload(value)
	if payload == nil {
		return ""
	}
	return readAccountIDCandidate(payload)
}

func readPlainString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func readAccountIDCandidate(value any) string {
	record, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	return firstNonEmpty(
		readString(record, "chatgpt_account_id"),
		readString(record, "chatgptAccountId"),
		readString(record, "account_id"),
		readString(record, "accountId"),
	)
}

func parseIDTokenPayload(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
			return parsed
		}
		segments := strings.Split(trimmed, ".")
		if len(segments) < 2 {
			return nil
		}
		decoded, err := base64.RawURLEncoding.DecodeString(segments[1])
		if err != nil {
			decoded, err = base64.URLEncoding.DecodeString(padBase64(segments[1]))
			if err != nil {
				return nil
			}
		}
		if err := json.Unmarshal(decoded, &parsed); err == nil {
			return parsed
		}
	}
	return nil
}

func parseRateLimit(raw map[string]any) *codexRateLimit {
	if raw == nil {
		return nil
	}
	limit := &codexRateLimit{
		PrimaryWindow:   parseWindow(readMap(raw, "primary_window", "primaryWindow")),
		SecondaryWindow: parseWindow(readMap(raw, "secondary_window", "secondaryWindow")),
	}
	if value, ok := readBoolPtr(raw, "allowed"); ok {
		limit.Allowed = value
	}
	limit.LimitReached = readBool(raw, "limit_reached", "limitReached")
	return limit
}

func parseWindow(raw map[string]any) *codexWindow {
	if raw == nil {
		return nil
	}
	window := &codexWindow{}
	if value, ok := readNumberPtr(raw, "used_percent", "usedPercent"); ok {
		window.UsedPercent = value
	}
	if value, ok := readNumberPtr(raw, "limit_window_seconds", "limitWindowSeconds"); ok {
		window.LimitWindowSeconds = value
	}
	return window
}

func classifyWindows(limit *codexRateLimit) (*codexWindow, *codexWindow) {
	if limit == nil {
		return nil, nil
	}
	raw := []*codexWindow{limit.PrimaryWindow, limit.SecondaryWindow}
	var fiveHour *codexWindow
	var weekly *codexWindow
	for _, window := range raw {
		if window == nil || window.LimitWindowSeconds == nil {
			continue
		}
		seconds := int(math.Round(*window.LimitWindowSeconds))
		if seconds == codexFiveHourWindow && fiveHour == nil {
			fiveHour = window
		} else if seconds == codexWeekWindow && weekly == nil {
			weekly = window
		}
	}
	if fiveHour == nil && limit.PrimaryWindow != weekly {
		fiveHour = limit.PrimaryWindow
	}
	if weekly == nil && limit.SecondaryWindow != fiveHour {
		weekly = limit.SecondaryWindow
	}
	return fiveHour, weekly
}

func deriveRateLimitUsedPercent(limit *codexRateLimit) *float64 {
	if limit == nil {
		return nil
	}
	var values []float64
	for _, window := range []*codexWindow{limit.PrimaryWindow, limit.SecondaryWindow} {
		if window != nil && window.UsedPercent != nil {
			values = append(values, *window.UsedPercent)
		}
	}
	if len(values) == 0 {
		return nil
	}
	max := values[0]
	for _, value := range values[1:] {
		if value > max {
			max = value
		}
	}
	return &max
}

func isRateLimitReached(limit *codexRateLimit) bool {
	if limit == nil {
		return false
	}
	if limit.Allowed != nil && !*limit.Allowed {
		return true
	}
	if limit.LimitReached {
		return true
	}
	for _, window := range []*codexWindow{limit.PrimaryWindow, limit.SecondaryWindow} {
		if window != nil && window.UsedPercent != nil && *window.UsedPercent >= 100 {
			return true
		}
	}
	return false
}

func normalizeBody(input any) (string, any) {
	if input == nil {
		return "", nil
	}
	if text, ok := input.(string); ok {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return text, nil
		}
		var parsed any
		if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
			return text, parsed
		}
		return text, text
	}
	data, err := json.Marshal(input)
	if err != nil {
		return fmt.Sprint(input), input
	}
	return string(data), input
}

func parseRecord(input any) map[string]any {
	switch typed := input.(type) {
	case map[string]any:
		return typed
	case string:
		var parsed map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(typed)), &parsed); err == nil {
			return parsed
		}
	}
	return nil
}

func readMap(record map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		value, ok := record[key]
		if !ok || value == nil {
			continue
		}
		if typed, ok := value.(map[string]any); ok {
			return typed
		}
	}
	return nil
}

func firstValue(record map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		value, ok := record[key]
		if ok {
			return value, true
		}
	}
	return nil, false
}

func readString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := record[key]
		if !ok || value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text != "" {
			return text
		}
	}
	return ""
}

func normalizeAuthIndex(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case float64:
		if math.Trunc(typed) == typed {
			return fmt.Sprintf("%.0f", typed)
		}
	case int:
		return fmt.Sprint(typed)
	case int64:
		return fmt.Sprint(typed)
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func isDisabledAuthFile(file authFile) bool {
	status := strings.ToLower(firstNonEmpty(readString(file, "status"), readString(file, "state")))
	if status == "disabled" || status == "inactive" {
		return true
	}
	value, ok := file["disabled"]
	if !ok || value == nil {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case float64:
		return typed != 0
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		return normalized == "true" || normalized == "1"
	default:
		return false
	}
}

func readBool(record map[string]any, keys ...string) bool {
	for _, key := range keys {
		value, ok := record[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return typed
		case string:
			normalized := strings.ToLower(strings.TrimSpace(typed))
			return normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on"
		case float64:
			return typed != 0
		}
	}
	return false
}

func readBoolPtr(record map[string]any, keys ...string) (*bool, bool) {
	for _, key := range keys {
		value, ok := record[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return &typed, true
		case string:
			normalized := strings.ToLower(strings.TrimSpace(typed))
			if normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on" {
				result := true
				return &result, true
			}
			if normalized == "false" || normalized == "0" || normalized == "no" || normalized == "off" {
				result := false
				return &result, true
			}
		case float64:
			result := typed != 0
			return &result, true
		}
	}
	return nil, false
}

func readNumberPtr(record map[string]any, keys ...string) (*float64, bool) {
	for _, key := range keys {
		value, ok := record[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return &typed, true
		case int:
			value := float64(typed)
			return &value, true
		case string:
			parsed, err := strconvParseFloat(typed)
			if err == nil {
				return &parsed, true
			}
		}
	}
	return nil, false
}

func readFloat(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case string:
		if parsed, err := strconvParseFloat(typed); err == nil {
			return parsed
		}
	}
	return fallback
}

func strconvParseFloat(value string) (float64, error) {
	return strconvParseFloat64(strings.TrimSpace(strings.TrimSuffix(value, "%")))
}

func strconvParseFloat64(value string) (float64, error) {
	var parsed float64
	_, err := fmt.Sscan(value, &parsed)
	return parsed, err
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func ptrFloat(value float64) *float64 {
	return &value
}

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func truncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "...(truncated)"
}

func sanitizeDetail(detail any) any {
	if detail == nil {
		return nil
	}
	data, err := json.Marshal(detail)
	if err != nil {
		return detail
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return detail
	}
	return redactValue(parsed)
}

func redactValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if isSecretKey(key) {
				result[key] = "[redacted]"
				continue
			}
			result[key] = redactValue(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			result[i] = redactValue(item)
		}
		return result
	default:
		return typed
	}
}

func isSecretKey(key string) bool {
	normalized := strings.ToLower(key)
	return strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "authorization") ||
		strings.Contains(normalized, "key")
}

func padBase64(value string) string {
	switch len(value) % 4 {
	case 2:
		return value + "=="
	case 3:
		return value + "="
	default:
		return value
	}
}
