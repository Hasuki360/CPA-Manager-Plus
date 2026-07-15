package model

const (
	QuotaCooldownOwnerUsage429        = "cpamp_usage_429"
	QuotaCooldownOwnerXAIFreeUsage     = "cpamp_xai_free_usage"
	QuotaCooldownOwnerXAIAuth401       = "cpamp_xai_auth_401"
	QuotaCooldownOwnerHTTP500Provider = "cpamp_http500_provider"

	QuotaCooldownStatusActive    = "active"
	QuotaCooldownStatusRecovered = "recovered"
	QuotaCooldownStatusSkipped   = "skipped"
)

type QuotaCooldown struct {
	ID               int64
	AuthFileName     string
	AuthIndex        string
	AccountSnapshot  string
	Provider         string
	RecoverAtMS      int64
	Owner            string
	EventHash        string
	PreDisabledState bool
	Status           string
	DisabledAtMS     int64
	RecoveredAtMS    int64
	LastError        string
	CreatedAtMS      int64
	UpdatedAtMS      int64
}

type QuotaCooldownUpsert struct {
	AuthFileName     string
	AuthIndex        string
	AccountSnapshot  string
	Provider         string
	RecoverAtMS      int64
	Owner            string
	EventHash        string
	PreDisabledState bool
	DisabledAtMS     int64
}
