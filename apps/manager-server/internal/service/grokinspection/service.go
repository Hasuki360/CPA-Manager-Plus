package grokinspection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpaauthfiles"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	defaultProbeModel        = "grok-4.5"
	xaiResponsesURL          = "https://cli-chat-proxy.grok.com/v1/responses"
	xaiChatCompletionsURL    = "https://cli-chat-proxy.grok.com/v1/chat/completions"
	maxStoredBodyText        = 2048
	maxCPAAPICallResponseSize = 16 * 1024 * 1024
)

var (
	ErrRunAlreadyActive  = errors.New("grok inspection is already running")
	ErrNotConfigured     = errors.New("usage service is not configured")
	ErrRunNotFound       = errors.New("grok inspection run not found")
	ErrRunNotCompleted   = errors.New("grok inspection run is not completed")
	ErrActionIDsRequired = errors.New("grok inspection action result ids are required")
	ErrNoActionable      = errors.New("grok inspection has no actionable results")
)

type Service struct {
	store                *store.Store
	managerConfigService *managerconfig.Service
	client               *http.Client

	mu      sync.Mutex
	running bool
}

type RunRequest struct {
	TriggerType     string `json:"triggerType,omitempty"`
	IncludeDisabled *bool  `json:"includeDisabled,omitempty"`
	OnlyDisabled    *bool  `json:"onlyDisabled,omitempty"`
	Workers         int    `json:"workers,omitempty"`
}

type RunDetail struct {
	Run     model.GrokInspectionRun      `json:"run"`
	Results []model.GrokInspectionResult `json:"results"`
	Logs    []model.GrokInspectionLog    `json:"logs"`
}

type ExecuteActionsRequest struct {
	ResultIDs []int64 `json:"resultIds"`
	Force     string  `json:"force,omitempty"` // optional: disable|enable|delete
}

type ActionOutcome struct {
	ResultID       int64  `json:"resultId,omitempty"`
	FileName       string `json:"fileName"`
	DisplayAccount string `json:"displayAccount"`
	Action         string `json:"action"`
	Status         string `json:"status"`
	Success        bool   `json:"success"`
	Error          string `json:"error,omitempty"`
}

type ExecuteActionsResult struct {
	Outcomes []ActionOutcome `json:"outcomes"`
	Detail   RunDetail       `json:"detail"`
}

type authFile map[string]any

type account struct {
	Key            string
	FileName       string
	DisplayAccount string
	AuthIndex      string
	Provider       string
	Disabled       bool
	Status         string
	File           authFile
}

type apiCallResponse struct {
	StatusCode    int
	HasStatusCode bool
	BodyText      string
}

type classifyResult struct {
	Classification string
	Action         string
	Reason         string
}

func New(st *store.Store, managerConfigService *managerconfig.Service, clients ...*http.Client) *Service {
	client := &http.Client{Timeout: 60 * time.Second}
	if len(clients) > 0 && clients[0] != nil {
		client = clients[0]
	}
	return &Service{
		store:                st,
		managerConfigService: managerConfigService,
		client:               client,
	}
}

func (s *Service) ResolveConfig(ctx context.Context) (model.ManagerGrokInspectionConfig, bool, error) {
	settings, setup, err := s.resolveRuntime(ctx)
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			return model.DefaultGrokInspectionConfig(), false, nil
		}
		return model.ManagerGrokInspectionConfig{}, false, err
	}
	_ = setup
	return settings, true, nil
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
	if req.IncludeDisabled != nil {
		settings.IncludeDisabled = *req.IncludeDisabled
	}
	if req.OnlyDisabled != nil {
		settings.OnlyDisabled = *req.OnlyDisabled
	}
	if req.Workers > 0 {
		settings.Workers = req.Workers
	}

	triggerType := strings.TrimSpace(req.TriggerType)
	if triggerType == "" {
		triggerType = model.GrokInspectionTriggerManual
	}
	startedAt := time.Now().UnixMilli()
	run, err := s.store.CreateGrokInspectionRun(ctx, model.GrokInspectionRun{
		TriggerType:  triggerType,
		Status:       model.GrokInspectionStatusRunning,
		StartedAtMS:  startedAt,
		Settings:     settings,
		SettingsJSON: model.MarshalGrokInspectionSettings(settings),
	})
	if err != nil {
		return RunDetail{}, err
	}
	persistCtx := context.WithoutCancel(ctx)
	logger := runLogger{service: s, runID: run.ID}
	logger.info(ctx, "Grok 巡检开始", map[string]any{
		"includeDisabled": settings.IncludeDisabled,
		"onlyDisabled":    settings.OnlyDisabled,
		"workers":         settings.Workers,
	})

	files, err := s.fetchAuthFiles(ctx, setup)
	if err != nil {
		logger.error(persistCtx, "加载认证文件列表失败", map[string]any{"error": err.Error()})
		return s.failRun(persistCtx, run, err)
	}

	accounts := make([]account, 0)
	for _, file := range files {
		item := toAccount(file)
		if !shouldInspectEntry(item.Provider, item.FileName, item.Provider, item.Disabled, item.Status, settings.IncludeDisabled, settings.OnlyDisabled) {
			continue
		}
		accounts = append(accounts, item)
	}
	run.TotalFiles = len(files)
	run.ProbeSetCount = len(accounts)
	_ = s.store.UpdateGrokInspectionRun(persistCtx, run)
	logger.info(ctx, "Grok 巡检集合已准备", map[string]any{
		"totalFiles":    len(files),
		"probeSetCount": len(accounts),
	})

	results := s.inspectAccounts(ctx, setup, settings, run.ID, accounts, logger)
	if err := ctx.Err(); err != nil {
		run = summarizeRun(run, results)
		run.Status = model.GrokInspectionStatusFailed
		run.Error = err.Error()
		run.FinishedAtMS = time.Now().UnixMilli()
		_ = s.store.UpdateGrokInspectionRun(persistCtx, run)
		return s.GetRun(persistCtx, run.ID)
	}

	// auto actions only when configured; default none
	if settings.AutoActionMode != "" && settings.AutoActionMode != "none" {
		results = s.applyAutoActions(ctx, setup, settings, results, logger)
	}

	for i := range results {
		results[i].RunID = run.ID
		if results[i].ID == 0 {
			saved, err := s.store.InsertGrokInspectionResult(persistCtx, results[i])
			if err == nil {
				results[i] = saved
			}
		} else {
			// already inserted during inspect
		}
	}

	run = summarizeRun(run, results)
	run.Status = model.GrokInspectionStatusCompleted
	run.FinishedAtMS = time.Now().UnixMilli()
	if err := s.store.UpdateGrokInspectionRun(persistCtx, run); err != nil {
		return RunDetail{}, err
	}
	logger.success(persistCtx, "Grok 巡检完成", map[string]any{
		"healthy":    run.HealthyCount,
		"permission": run.PermissionCount,
		"quota":      run.QuotaCount,
		"reauth":     run.ReauthCount,
	})
	return s.GetRun(persistCtx, run.ID)
}

func (s *Service) ListRuns(ctx context.Context, limit int) ([]model.GrokInspectionRun, error) {
	return s.store.ListGrokInspectionRuns(ctx, limit)
}

func (s *Service) GetRun(ctx context.Context, id int64) (RunDetail, error) {
	run, ok, err := s.store.GetGrokInspectionRun(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	if !ok {
		return RunDetail{}, ErrRunNotFound
	}
	results, err := s.store.ListGrokInspectionResults(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	logs, err := s.store.ListGrokInspectionLogs(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	return RunDetail{Run: run, Results: results, Logs: logs}, nil
}

func (s *Service) ExecuteManualActions(ctx context.Context, runID int64, req ExecuteActionsRequest) (ExecuteActionsResult, error) {
	if len(req.ResultIDs) == 0 {
		return ExecuteActionsResult{}, ErrActionIDsRequired
	}
	detail, err := s.GetRun(ctx, runID)
	if err != nil {
		return ExecuteActionsResult{}, err
	}
	if detail.Run.Status != model.GrokInspectionStatusCompleted {
		return ExecuteActionsResult{}, ErrRunNotCompleted
	}
	settings, setup, err := s.resolveRuntime(ctx)
	if err != nil {
		return ExecuteActionsResult{}, err
	}
	_ = settings

	byID := map[int64]model.GrokInspectionResult{}
	for _, item := range detail.Results {
		byID[item.ID] = item
	}
	targets := make([]model.GrokInspectionResult, 0, len(req.ResultIDs))
	for _, id := range req.ResultIDs {
		item, ok := byID[id]
		if !ok {
			continue
		}
		force := strings.ToLower(strings.TrimSpace(req.Force))
		if force == "disable" || force == "enable" || force == "delete" {
			item.Action = force
		}
		if item.Action == "keep" || item.Action == "" {
			continue
		}
		targets = append(targets, item)
	}
	if len(targets) == 0 {
		return ExecuteActionsResult{}, ErrNoActionable
	}

	outcomes := make([]ActionOutcome, 0, len(targets))
	for _, item := range targets {
		actionErr := s.executeAction(ctx, setup, item)
		outcome := ActionOutcome{
			ResultID:       item.ID,
			FileName:       item.FileName,
			DisplayAccount: item.DisplayAccount,
			Action:         item.Action,
		}
		if actionErr != nil {
			outcome.Status = model.GrokInspectionActionStatusFailed
			outcome.Error = actionErr.Error()
		} else {
			outcome.Status = model.GrokInspectionActionStatusSuccess
			outcome.Success = true
			// update in-memory for response summary
			item.ActionStatus = model.GrokInspectionActionStatusSuccess
			item.ExecutedAction = item.Action
		}
		outcomes = append(outcomes, outcome)
	}
	// reload detail (results already stored; action status not rewritten in first version)
	detail, _ = s.GetRun(ctx, runID)
	return ExecuteActionsResult{Outcomes: outcomes, Detail: detail}, nil
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
	s.running = false
	s.mu.Unlock()
}

func (s *Service) resolveRuntime(ctx context.Context) (model.ManagerGrokInspectionConfig, store.Setup, error) {
	setup, ok, err := s.store.LoadSetup(ctx)
	if err != nil {
		return model.ManagerGrokInspectionConfig{}, store.Setup{}, err
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" || strings.TrimSpace(setup.ManagementKey) == "" {
		return model.ManagerGrokInspectionConfig{}, store.Setup{}, ErrNotConfigured
	}
	cfg := model.DefaultGrokInspectionConfig()
	// optional override from manager config map if present later
	return cfg, setup, nil
}

func (s *Service) failRun(ctx context.Context, run model.GrokInspectionRun, err error) (RunDetail, error) {
	run.Status = model.GrokInspectionStatusFailed
	run.Error = err.Error()
	run.FinishedAtMS = time.Now().UnixMilli()
	if updateErr := s.store.UpdateGrokInspectionRun(ctx, run); updateErr != nil {
		return RunDetail{}, updateErr
	}
	return s.GetRun(ctx, run.ID)
}

func (s *Service) fetchAuthFiles(ctx context.Context, setup store.Setup) ([]authFile, error) {
	files, err := cpaauthfiles.New(s.client).Fetch(ctx, setup.CPAUpstreamURL, setup.ManagementKey)
	if err != nil {
		return nil, err
	}
	result := make([]authFile, 0, len(files))
	for _, file := range files {
		result = append(result, authFile(file.Raw))
	}
	return result, nil
}

func (s *Service) inspectAccounts(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerGrokInspectionConfig,
	runID int64,
	accounts []account,
	logger runLogger,
) []model.GrokInspectionResult {
	if len(accounts) == 0 {
		return nil
	}
	workers := settings.Workers
	if workers <= 0 {
		workers = 1
	}
	jobs := make(chan account)
	results := make(chan model.GrokInspectionResult, len(accounts))
	var wg sync.WaitGroup
	for i := 0; i < workers && i < len(accounts); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				result := s.inspectSingleAccount(ctx, setup, settings, item, logger)
				result.RunID = runID
				if saved, err := s.store.InsertGrokInspectionResult(ctx, result); err == nil {
					result = saved
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
	out := make([]model.GrokInspectionResult, 0, len(accounts))
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
	settings model.ManagerGrokInspectionConfig,
	item account,
	logger runLogger,
) model.GrokInspectionResult {
	base := resultFromAccount(item)
	modelName := strings.TrimSpace(settings.ProbeModel)
	if modelName == "" {
		modelName = defaultProbeModel
	}
	base.Model = modelName
	if item.AuthIndex == "" {
		base.Classification = "probe_error"
		base.Action = "keep"
		base.ActionReason = "缺少 auth_index"
		base.Error = "缺少 auth_index"
		return base
	}

	body := fmt.Sprintf(`{"model":%q,"input":"ping","stream":false}`, modelName)
	resp, err := s.callHostAPICall(ctx, setup, settings, item.AuthIndex, http.MethodPost, xaiResponsesURL, []byte(body))
	if err != nil {
		classified := classifyProbe(classifyInput{
			Disabled:     item.Disabled,
			RequestError: err.Error(),
		})
		base.Classification = classified.Classification
		base.Action = classified.Action
		base.ActionReason = classified.Reason
		base.Error = err.Error()
		return base
	}
	status := resp.StatusCode
	parsed := extractError(resp.BodyText)
	// bare 429 short retry
	if status == http.StatusTooManyRequests && !isFreeUsageExhausted(parsed.Code, parsed.Message) {
		time.Sleep(350 * time.Millisecond)
		if retry, retryErr := s.callHostAPICall(ctx, setup, settings, item.AuthIndex, http.MethodPost, xaiResponsesURL, []byte(body)); retryErr == nil {
			resp = retry
			status = retry.StatusCode
			parsed = extractError(retry.BodyText)
		}
	}
	classified := classifyProbe(classifyInput{
		ChatStatus:  status,
		ChatCode:    parsed.Code,
		ChatError:   parsed.Message,
		Disabled:    item.Disabled,
		RequestError: "",
	})
	// ambiguous fallback
	if isAmbiguous(classified.Classification, status) {
		chatBody := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"ping"}],"stream":false}`, modelName)
		if fallback, fallbackErr := s.callHostAPICall(ctx, setup, settings, item.AuthIndex, http.MethodPost, xaiChatCompletionsURL, []byte(chatBody)); fallbackErr == nil {
			// keep authoritative free-usage / permission / reauth from primary if present
			if classified.Classification != "quota_exhausted" &&
				classified.Classification != "permission_denied" &&
				classified.Classification != "reauth" {
				fbParsed := extractError(fallback.BodyText)
				classified = classifyProbe(classifyInput{
					ChatStatus: fallback.StatusCode,
					ChatCode:   fbParsed.Code,
					ChatError:  fbParsed.Message,
					Disabled:   item.Disabled,
				})
				status = fallback.StatusCode
			}
		}
	}
	base.StatusCode = &status
	base.Classification = classified.Classification
	base.Action = classified.Action
	base.ActionReason = classified.Reason
	if classified.Classification == "probe_error" || classified.Classification == "unknown" {
		base.Error = firstNonEmpty(parsed.Message, resp.BodyText)
		if len(base.Error) > 400 {
			base.Error = base.Error[:400]
		}
	}
	logger.info(ctx, "账号探测完成", map[string]any{
		"fileName":       item.FileName,
		"classification": base.Classification,
		"action":         base.Action,
		"statusCode":     status,
	})
	return base
}

func isAmbiguous(classification string, status int) bool {
	switch classification {
	case "healthy", "quota_exhausted", "permission_denied", "reauth":
		return false
	default:
		return true
	}
}

func (s *Service) callHostAPICall(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerGrokInspectionConfig,
	authIndex string,
	method string,
	targetURL string,
	body []byte,
) (apiCallResponse, error) {
	headers := map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type":  "application/json",
	}
	payload := map[string]any{
		"authIndex": authIndex,
		"method":    method,
		"url":       targetURL,
		"header":    headers,
	}
	if len(body) > 0 {
		payload["body"] = string(body)
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return apiCallResponse{}, err
	}
	requestCtx := ctx
	cancel := func() {}
	timeout := settings.TimeoutMS
	if timeout <= 0 {
		timeout = 25000
	}
	requestCtx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+"/v0/management/api-call",
		bytes.NewReader(data),
	)
	if err != nil {
		return apiCallResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return apiCallResponse{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, maxStoredBodyText))
		return apiCallResponse{}, fmt.Errorf("api-call failed: %s %s", res.Status, string(raw))
	}
	var raw map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, maxCPAAPICallResponseSize)).Decode(&raw); err != nil {
		return apiCallResponse{}, err
	}
	statusRaw, hasStatus := firstValue(raw, "status_code", "statusCode")
	statusCode := int(readFloat(statusRaw, 0))
	bodyRaw, _ := firstValue(raw, "body")
	bodyText := asString(bodyRaw)
	return apiCallResponse{
		StatusCode:    statusCode,
		HasStatusCode: hasStatus,
		BodyText:      bodyText,
	}, nil
}

func (s *Service) applyAutoActions(
	ctx context.Context,
	setup store.Setup,
	settings model.ManagerGrokInspectionConfig,
	results []model.GrokInspectionResult,
	logger runLogger,
) []model.GrokInspectionResult {
	for i := range results {
		item := results[i]
		desired := item.Action
		if settings.AutoActionMode == "disable" && desired != "disable" && desired != "delete" {
			continue
		}
		if settings.AutoActionMode == "enable" && desired != "enable" {
			continue
		}
		if settings.AutoActionMode == "delete" && desired != "delete" {
			continue
		}
		if desired == "keep" || desired == "" {
			continue
		}
		if err := s.executeAction(ctx, setup, item); err != nil {
			results[i].ActionStatus = model.GrokInspectionActionStatusFailed
			results[i].ActionError = err.Error()
			logger.error(ctx, "自动动作失败", map[string]any{"fileName": item.FileName, "error": err.Error()})
		} else {
			results[i].ActionStatus = model.GrokInspectionActionStatusSuccess
			results[i].ExecutedAction = desired
		}
	}
	return results
}

func (s *Service) executeAction(ctx context.Context, setup store.Setup, item model.GrokInspectionResult) error {
	switch item.Action {
	case "delete":
		return s.deleteAuthFile(ctx, setup, item.FileName)
	case "disable", "enable":
		disabled := item.Action == "disable"
		return s.patchAuthStatus(ctx, setup, item.FileName, disabled)
	default:
		return nil
	}
}

func (s *Service) deleteAuthFile(ctx context.Context, setup store.Setup, name string) error {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+"/v0/management/auth-files?name="+urlQueryEscape(name),
		nil,
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("delete auth-file failed: %s %s", res.Status, string(body))
	}
	return nil
}

func (s *Service) patchAuthStatus(ctx context.Context, setup store.Setup, name string, disabled bool) error {
	payload, _ := json.Marshal(map[string]any{"name": name, "disabled": disabled})
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPatch,
		cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+"/v0/management/auth-files/status",
		bytes.NewReader(payload),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("patch auth-file status failed: %s %s", res.Status, string(body))
	}
	return nil
}

func toAccount(file authFile) account {
	name := firstNonEmpty(asString(file["name"]), asString(file["file"]), asString(file["fileName"]))
	email := asString(file["email"])
	label := asString(file["label"])
	provider := firstNonEmpty(asString(file["provider"]), asString(file["type"]))
	authIndex := firstNonEmpty(asString(file["auth_index"]), asString(file["authIndex"]), asString(file["id"]))
	disabled := asBool(file["disabled"])
	status := asString(file["status"])
	display := firstNonEmpty(email, label, name, authIndex)
	return account{
		Key:            firstNonEmpty(authIndex, name),
		FileName:       name,
		DisplayAccount: display,
		AuthIndex:      authIndex,
		Provider:       provider,
		Disabled:       disabled || isDisabledEntry(disabled, status),
		Status:         status,
		File:           file,
	}
}

func resultFromAccount(item account) model.GrokInspectionResult {
	return model.GrokInspectionResult{
		AccountKey:     item.Key,
		FileName:       item.FileName,
		DisplayAccount: item.DisplayAccount,
		AuthIndex:      item.AuthIndex,
		Provider:       item.Provider,
		Disabled:       item.Disabled,
		ActionStatus:   model.GrokInspectionActionStatusNone,
	}
}

func summarizeRun(run model.GrokInspectionRun, results []model.GrokInspectionResult) model.GrokInspectionRun {
	run.HealthyCount = 0
	run.PermissionCount = 0
	run.QuotaCount = 0
	run.ReauthCount = 0
	run.ModelUnavailCnt = 0
	run.ProbeErrorCount = 0
	run.UnknownCount = 0
	run.DeleteCount = 0
	run.DisableCount = 0
	run.EnableCount = 0
	run.KeepCount = 0
	for _, item := range results {
		switch item.Classification {
		case "healthy":
			run.HealthyCount++
		case "permission_denied":
			run.PermissionCount++
		case "quota_exhausted":
			run.QuotaCount++
		case "reauth":
			run.ReauthCount++
		case "model_unavailable":
			run.ModelUnavailCnt++
		case "probe_error":
			run.ProbeErrorCount++
		default:
			run.UnknownCount++
		}
		switch item.Action {
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

// ---- classify (ported from grok-inspection) ----

type classifyInput struct {
	ChatStatus   int
	ChatCode     string
	ChatError    string
	Disabled     bool
	RequestError string
}

type probeError struct {
	Code    string
	Message string
}

func lower(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func containsAny(text string, needles ...string) bool {
	value := lower(text)
	for _, needle := range needles {
		if needle == "" {
			continue
		}
		if strings.Contains(value, lower(needle)) {
			return true
		}
	}
	return false
}

func isFreeUsageExhausted(code, message string) bool {
	blob := lower(code) + " " + lower(message)
	return containsAny(blob,
		"free-usage-exhausted",
		"used all the included free usage",
		"included free usage has been exhausted",
	)
}

func isXAIEntry(provider, name, entryType string) bool {
	provider = lower(provider)
	entryType = lower(entryType)
	name = lower(name)
	if provider == "xai" || provider == "x-ai" || provider == "grok" {
		return true
	}
	if entryType == "xai" || entryType == "x-ai" || entryType == "grok" {
		return true
	}
	return strings.HasPrefix(name, "xai-") || strings.HasPrefix(name, "grok-")
}

func isDisabledEntry(disabled bool, status string) bool {
	if disabled {
		return true
	}
	status = lower(status)
	return status == "disabled" || status == "inactive"
}

func shouldInspectEntry(provider, name, entryType string, disabled bool, status string, includeDisabled, onlyDisabled bool) bool {
	if !isXAIEntry(provider, name, entryType) {
		return false
	}
	isDisabled := isDisabledEntry(disabled, status)
	if onlyDisabled {
		return isDisabled
	}
	if !includeDisabled && isDisabled {
		return false
	}
	return true
}

func extractError(body string) probeError {
	body = strings.TrimSpace(body)
	if body == "" {
		return probeError{}
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		return probeError{Message: truncate(body, 400)}
	}
	code := asString(data["code"])
	message := ""
	switch errValue := data["error"].(type) {
	case map[string]any:
		if code == "" {
			code = asString(errValue["code"])
		}
		message = firstNonEmpty(asString(errValue["message"]), asString(errValue["error"]))
	case string:
		message = errValue
	}
	if message == "" {
		message = asString(data["message"])
	}
	return probeError{Code: code, Message: truncate(message, 400)}
}

func classifyProbe(input classifyInput) classifyResult {
	status := input.ChatStatus
	blob := lower(input.ChatCode) + " " + lower(input.ChatError)
	disabled := input.Disabled
	if status == http.StatusUnauthorized || containsAny(blob, "token is expired", "token has been invalidated", "invalid_grant", "unauthorized") {
		return classifyResult{Classification: "reauth", Action: "delete", Reason: "认证已过期或失效"}
	}
	if isFreeUsageExhausted(input.ChatCode, input.ChatError) {
		action := "disable"
		if disabled {
			action = "keep"
		}
		return classifyResult{Classification: "quota_exhausted", Action: action, Reason: "额度已用尽"}
	}
	if status == http.StatusTooManyRequests {
		return classifyResult{Classification: "probe_error", Action: "keep", Reason: "临时限流 (HTTP 429)，建议稍后重试"}
	}
	if status == http.StatusPaymentRequired || status == http.StatusForbidden || containsAny(blob, "permission-denied", "chat endpoint is denied", "deactivated", "suspended", "banned") {
		action := "disable"
		if disabled {
			action = "keep"
		}
		reason := "对话权限被拒绝"
		if status > 0 {
			reason = fmt.Sprintf("%s (HTTP %d)", reason, status)
		}
		return classifyResult{Classification: "permission_denied", Action: action, Reason: reason}
	}
	if status == http.StatusNotFound || containsAny(blob, "not-found", "does not exist", "no access to it") {
		return classifyResult{Classification: "model_unavailable", Action: "keep", Reason: "测试模型不可用"}
	}
	if status >= 200 && status < 300 {
		action := "keep"
		if disabled {
			action = "enable"
		}
		return classifyResult{Classification: "healthy", Action: action, Reason: "对话测试成功"}
	}
	if strings.TrimSpace(input.RequestError) != "" || status > 0 {
		reason := strings.TrimSpace(input.RequestError)
		if reason == "" {
			reason = "探测失败"
			if status > 0 {
				reason = fmt.Sprintf("%s (HTTP %d)", reason, status)
			}
		}
		return classifyResult{Classification: "probe_error", Action: "keep", Reason: reason}
	}
	return classifyResult{Classification: "unknown", Action: "keep", Reason: "无法可靠分类"}
}

// ---- helpers ----

type runLogger struct {
	service *Service
	runID   int64
}

func (l runLogger) info(ctx context.Context, msg string, detail map[string]any) {
	l.log(ctx, "info", msg, detail)
}
func (l runLogger) error(ctx context.Context, msg string, detail map[string]any) {
	l.log(ctx, "error", msg, detail)
}
func (l runLogger) success(ctx context.Context, msg string, detail map[string]any) {
	l.log(ctx, "success", msg, detail)
}
func (l runLogger) log(ctx context.Context, level, msg string, detail map[string]any) {
	raw, _ := json.Marshal(detail)
	_, _ = l.service.store.InsertGrokInspectionLog(ctx, model.GrokInspectionLog{
		RunID:      l.runID,
		Level:      level,
		Message:    msg,
		DetailJSON: string(raw),
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return fmt.Sprintf("%.0f", typed)
	case json.Number:
		return typed.String()
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func asBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return lower(typed) == "true" || typed == "1"
	case float64:
		return typed != 0
	default:
		return false
	}
}

func firstValue(raw map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			return value, true
		}
	}
	return nil, false
}

func readFloat(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		if f, err := typed.Float64(); err == nil {
			return f
		}
	case string:
		var f float64
		if _, err := fmt.Sscanf(typed, "%f", &f); err == nil {
			return f
		}
	}
	return fallback
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || len(value) <= max {
		return value
	}
	r := []rune(value)
	if len(r) <= max {
		return value
	}
	return string(r[:max]) + "…"
}

func urlQueryEscape(value string) string {
	// minimal escape for file names
	replacer := strings.NewReplacer(" ", "%20", "+", "%2B", "&", "%26", "?", "%3F")
	return replacer.Replace(value)
}
