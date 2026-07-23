package model

// AutomationSettings stores UI-managed account-processing-policy overrides.
// Nil fields mean "not configured in DB" and fall back to startup config unless
// the corresponding environment variable explicitly locks the value.
//
// JSON field names use the business-facing account-processing-policy vocabulary
// (quota cooldown / auth issue queue / auth issue auto-disable) to match
// the HTTP route and UI. The underlying config.json keys and environment
// variables keep their original names, which are surfaced separately.
type AutomationSettings struct {
	QuotaCooldownEnabled               *bool                     `json:"codexQuotaCooldownEnabled,omitempty"`
	AntigravityQuotaCooldownEnabled    *bool                     `json:"antigravityQuotaCooldownEnabled,omitempty"`
	AccountActionsEnabled              *bool                     `json:"authIssueQueueEnabled,omitempty"`
	AccountActionsAutoDisable          *bool                     `json:"authIssueAutoDisableEnabled,omitempty"`
	CharityModelMonitorEnabled         *bool                     `json:"charityModelMonitorEnabled,omitempty"`
	CharityModelMonitorIntervalMinutes *int                      `json:"charityModelMonitorIntervalMinutes,omitempty"`
	CharityModelMonitorSites           []CharityModelMonitorSite `json:"charityModelMonitorSites,omitempty"`
	UpdatedAtMS                        int64                     `json:"updatedAtMs,omitempty"`
}
