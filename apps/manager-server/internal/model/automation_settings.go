package model

// AutomationSettings stores UI-managed account-processing-policy overrides.
// Nil fields mean "not configured in DB" and fall back to startup config unless
// the corresponding environment variable explicitly locks the value.
//
// JSON field names use the business-facing account-processing-policy vocabulary
// (quota cooldown / auth issue queue / auth issue auto-disable) to match
// the HTTP route and UI. The underlying config.json keys and environment
// variables keep their original names, which are surfaced separately.
const (
	DefaultHTTP500CooldownWindowMinutes   = 10
	DefaultHTTP500CooldownThreshold       = 3
	DefaultHTTP500CooldownDurationMinutes = 10
	MinHTTP500CooldownWindowMinutes       = 1
	MaxHTTP500CooldownWindowMinutes       = 1440
	MinHTTP500CooldownThreshold           = 1
	MaxHTTP500CooldownThreshold           = 100
	MinHTTP500CooldownDurationMinutes     = 1
	MaxHTTP500CooldownDurationMinutes     = 1440
)

type AutomationSettings struct {
	QuotaCooldownEnabled                 *bool                     `json:"codexQuotaCooldownEnabled,omitempty"`
	AntigravityQuotaCooldownEnabled      *bool                     `json:"antigravityQuotaCooldownEnabled,omitempty"`
	AccountActionsEnabled                *bool                     `json:"authIssueQueueEnabled,omitempty"`
	AccountActionsAutoDisable            *bool                     `json:"authIssueAutoDisableEnabled,omitempty"`
	CharityModelMonitorEnabled           *bool                     `json:"charityModelMonitorEnabled,omitempty"`
	CharityModelMonitorIntervalMinutes   *int                      `json:"charityModelMonitorIntervalMinutes,omitempty"`
	CharityModelMonitorSites             []CharityModelMonitorSite `json:"charityModelMonitorSites,omitempty"`
	HTTP500CooldownWindowMinutes         *int                      `json:"http500CooldownWindowMinutes,omitempty"`
	HTTP500CooldownThreshold             *int                      `json:"http500CooldownThreshold,omitempty"`
	HTTP500CooldownDurationMinutes       *int                      `json:"http500CooldownDurationMinutes,omitempty"`
	UpdatedAtMS                          int64                     `json:"updatedAtMs,omitempty"`
}

func NormalizeHTTP500CooldownWindowMinutes(value int) int {
	return clampInt(value, DefaultHTTP500CooldownWindowMinutes, MinHTTP500CooldownWindowMinutes, MaxHTTP500CooldownWindowMinutes)
}

func NormalizeHTTP500CooldownThreshold(value int) int {
	return clampInt(value, DefaultHTTP500CooldownThreshold, MinHTTP500CooldownThreshold, MaxHTTP500CooldownThreshold)
}

func NormalizeHTTP500CooldownDurationMinutes(value int) int {
	return clampInt(value, DefaultHTTP500CooldownDurationMinutes, MinHTTP500CooldownDurationMinutes, MaxHTTP500CooldownDurationMinutes)
}

func clampInt(value int, fallback int, min int, max int) int {
	if value <= 0 {
		value = fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
