package model

import (
	"encoding/json"
	"strings"
)

const (
	GrokInspectionStatusRunning   = "running"
	GrokInspectionStatusCompleted = "completed"
	GrokInspectionStatusFailed    = "failed"

	GrokInspectionTriggerManual = "manual"

	GrokInspectionActionStatusNone    = "none"
	GrokInspectionActionStatusSuccess = "success"
	GrokInspectionActionStatusFailed  = "failed"
	GrokInspectionActionStatusSkipped = "skipped"
)

// ManagerGrokInspectionConfig is the runtime config for fused Grok inspection.
type ManagerGrokInspectionConfig struct {
	Enabled         *bool  `json:"enabled,omitempty"`
	Workers         int    `json:"workers,omitempty"`
	TimeoutMS       int    `json:"timeoutMs,omitempty"`
	IncludeDisabled bool   `json:"includeDisabled,omitempty"`
	OnlyDisabled    bool   `json:"onlyDisabled,omitempty"`
	ProbeModel      string `json:"probeModel,omitempty"`
	AutoActionMode  string `json:"autoActionMode,omitempty"` // none|enable|disable|delete
}

type GrokInspectionRun struct {
	ID              int64                       `json:"id"`
	TriggerType     string                      `json:"triggerType"`
	Status          string                      `json:"status"`
	StartedAtMS     int64                       `json:"startedAtMs"`
	FinishedAtMS    int64                       `json:"finishedAtMs,omitempty"`
	TotalFiles      int                         `json:"totalFiles"`
	ProbeSetCount   int                         `json:"probeSetCount"`
	HealthyCount    int                         `json:"healthyCount"`
	PermissionCount int                         `json:"permissionCount"`
	QuotaCount      int                         `json:"quotaCount"`
	ReauthCount     int                         `json:"reauthCount"`
	ModelUnavailCnt int                         `json:"modelUnavailableCount"`
	ProbeErrorCount int                         `json:"probeErrorCount"`
	UnknownCount    int                         `json:"unknownCount"`
	DeleteCount     int                         `json:"deleteCount"`
	DisableCount    int                         `json:"disableCount"`
	EnableCount     int                         `json:"enableCount"`
	KeepCount       int                         `json:"keepCount"`
	Error           string                      `json:"error,omitempty"`
	Settings        ManagerGrokInspectionConfig `json:"settings"`
	SettingsJSON    string                      `json:"-"`
	CreatedAtMS     int64                       `json:"createdAtMs"`
	UpdatedAtMS     int64                       `json:"updatedAtMs"`
}

type GrokInspectionResult struct {
	ID             int64  `json:"id"`
	RunID          int64  `json:"runId"`
	AccountKey     string `json:"accountKey"`
	FileName       string `json:"fileName"`
	DisplayAccount string `json:"displayAccount"`
	AuthIndex      string `json:"authIndex,omitempty"`
	Provider       string `json:"provider"`
	Disabled       bool   `json:"disabled"`
	Classification string `json:"classification"`
	Action         string `json:"action"`
	ActionReason   string `json:"actionReason"`
	ActionStatus   string `json:"actionStatus,omitempty"`
	ExecutedAction string `json:"executedAction,omitempty"`
	ActionError    string `json:"actionError,omitempty"`
	StatusCode     *int   `json:"statusCode,omitempty"`
	Model          string `json:"model,omitempty"`
	Error          string `json:"error,omitempty"`
	CreatedAtMS    int64  `json:"createdAtMs"`
}

type GrokInspectionLog struct {
	ID         int64  `json:"id"`
	RunID      int64  `json:"runId"`
	Level      string `json:"level"`
	Message    string `json:"message"`
	DetailJSON string `json:"-"`
	Detail     any    `json:"detail,omitempty"`
	CreatedAtMS int64 `json:"createdAtMs"`
}

func DefaultGrokInspectionConfig() ManagerGrokInspectionConfig {
	return ManagerGrokInspectionConfig{
		Enabled:         boolPtr(true),
		Workers:         4,
		TimeoutMS:       25000,
		IncludeDisabled: true,
		OnlyDisabled:    false,
		ProbeModel:      "grok-4.5",
		AutoActionMode:  "none",
	}
}

func NormalizeGrokInspectionConfig(input ManagerGrokInspectionConfig, fallback ManagerGrokInspectionConfig) ManagerGrokInspectionConfig {
	base := fallback
	if base.Workers == 0 {
		base = DefaultGrokInspectionConfig()
	}
	next := base
	if input.Enabled != nil {
		next.Enabled = boolPtr(*input.Enabled)
	}
	if input.Workers > 0 {
		next.Workers = input.Workers
	}
	if input.TimeoutMS > 0 {
		next.TimeoutMS = input.TimeoutMS
	}
	next.IncludeDisabled = input.IncludeDisabled
	next.OnlyDisabled = input.OnlyDisabled
	if strings.TrimSpace(input.ProbeModel) != "" {
		next.ProbeModel = strings.TrimSpace(input.ProbeModel)
	}
	mode := strings.ToLower(strings.TrimSpace(input.AutoActionMode))
	switch mode {
	case "none", "enable", "disable", "delete":
		next.AutoActionMode = mode
	case "":
		// keep fallback
	default:
		next.AutoActionMode = "none"
	}
	return next
}

func MarshalGrokInspectionSettings(cfg ManagerGrokInspectionConfig) string {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func UnmarshalGrokInspectionSettings(raw string) ManagerGrokInspectionConfig {
	cfg := DefaultGrokInspectionConfig()
	if strings.TrimSpace(raw) == "" {
		return cfg
	}
	var parsed ManagerGrokInspectionConfig
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return cfg
	}
	return NormalizeGrokInspectionConfig(parsed, cfg)
}
