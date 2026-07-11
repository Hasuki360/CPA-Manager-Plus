package automation

import (
	"context"
	"errors"
	"log"
	"sync"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	SourceStartup = "startup"
	SourceEnv     = "env"
	SourceDB      = "database"
)

// settingsStore is the subset of *store.Store used by the service. It is an
// interface so tests can inject failing loaders to exercise error handling.
type settingsStore interface {
	LoadAutomationSettings(ctx context.Context) (store.AutomationSettings, bool, error)
	SaveAutomationSettings(ctx context.Context, settings store.AutomationSettings) (store.AutomationSettings, error)
	LoadCharityModelMonitorState(ctx context.Context) (store.CharityModelMonitorState, bool, error)
}

type Capability struct {
	Enabled       bool   `json:"enabled"`
	Configured    bool   `json:"configured"`
	Source        string `json:"source"`
	Locked        bool   `json:"locked"`
	EnvKey        string `json:"envKey"`
	ConfigFileKey string `json:"configFileKey"`
	DependsOn     string `json:"dependsOn,omitempty"`
}

type Status struct {
	Source                             string                            `json:"source"`
	UpdatedAtMS                        int64                             `json:"updatedAtMs,omitempty"`
	QuotaCooldown                      Capability                        `json:"codexQuotaCooldown"`
	AntigravityQuotaCooldown           Capability                        `json:"antigravityQuotaCooldown"`
	AccountActions                     Capability                        `json:"authIssueQueue"`
	AccountActionsAutoDisable          Capability                        `json:"authIssueAutoDisable"`
	CharityModelMonitor                Capability                        `json:"charityModelMonitor"`
	CharityModelMonitorIntervalMinutes int                               `json:"charityModelMonitorIntervalMinutes"`
	CharityModelMonitorSites           []store.CharityModelMonitorSite    `json:"charityModelMonitorSites"`
	CharityModelMonitorState           *store.CharityModelMonitorState    `json:"charityModelMonitorState,omitempty"`
	HTTP500CooldownWindowMinutes       int                               `json:"http500CooldownWindowMinutes"`
	HTTP500CooldownThreshold           int                               `json:"http500CooldownThreshold"`
	HTTP500CooldownDurationMinutes     int                               `json:"http500CooldownDurationMinutes"`
}

type UpdateRequest struct {
	QuotaCooldownEnabled            *bool `json:"codexQuotaCooldownEnabled,omitempty"`
	AntigravityQuotaCooldownEnabled *bool `json:"antigravityQuotaCooldownEnabled,omitempty"`
	AccountActionsEnabled           *bool `json:"authIssueQueueEnabled,omitempty"`
	AccountActionsAutoDisable       *bool `json:"authIssueAutoDisableEnabled,omitempty"`
	CharityModelMonitorEnabled         *bool                         `json:"charityModelMonitorEnabled,omitempty"`
	CharityModelMonitorIntervalMinutes *int                          `json:"charityModelMonitorIntervalMinutes,omitempty"`
	CharityModelMonitorSites           []store.CharityModelMonitorSite `json:"charityModelMonitorSites,omitempty"`
	HTTP500CooldownWindowMinutes       *int                          `json:"http500CooldownWindowMinutes,omitempty"`
	HTTP500CooldownThreshold        *int  `json:"http500CooldownThreshold,omitempty"`
	HTTP500CooldownDurationMinutes  *int  `json:"http500CooldownDurationMinutes,omitempty"`
}

type Service struct {
	cfg   config.Config
	store settingsStore

	mu        sync.RWMutex
	lastKnown store.AutomationSettings
	hasKnown  bool

	// updateMu serializes the read-modify-write in Update so concurrent PATCH
	// requests cannot overwrite each other's fields based on a stale snapshot.
	updateMu sync.Mutex
}

func New(cfg config.Config, st ...*store.Store) *Service {
	var storeRef settingsStore
	if len(st) > 0 {
		storeRef = st[0]
	}
	return &Service{cfg: cfg, store: storeRef}
}

// Status returns the effective account-processing policy. Unlike the runtime
// gating path, a read failure is surfaced to the caller so the UI does not
// silently show a stale/default state.
func (s *Service) Status(ctx context.Context) (Status, error) {
	settings, _, err := s.loadSettings(ctx)
	if err != nil {
		return Status{}, err
	}
	status := s.statusFromSettings(settings)
	if s.store != nil {
		state, ok, err := s.store.LoadCharityModelMonitorState(ctx)
		if err != nil {
			return Status{}, err
		}
		if ok {
			status.CharityModelMonitorState = &state
		}
	}
	return status, nil
}

func (s *Service) Update(ctx context.Context, req UpdateRequest) (Status, error) {
	if s.store == nil {
		return Status{}, errors.New("automation settings store is not configured")
	}
	// Hold updateMu across the full read-modify-write so two concurrent PATCH
	// requests (different admins / tabs / fields) cannot interleave and lose a
	// field based on a stale snapshot.
	s.updateMu.Lock()
	defer s.updateMu.Unlock()

	current, _, err := s.loadSettings(ctx)
	if err != nil {
		return Status{}, err
	}
	if req.QuotaCooldownEnabled != nil {
		if s.cfg.QuotaCooldownEnvSet {
			return Status{}, errors.New("quotaCooldownEnabled is locked by environment variable")
		}
		current.QuotaCooldownEnabled = boolPtr(*req.QuotaCooldownEnabled)
	}
	if req.AntigravityQuotaCooldownEnabled != nil {
		if s.cfg.AntigravityQuotaCooldownEnvSet {
			return Status{}, errors.New("antigravityQuotaCooldownEnabled is locked by environment variable")
		}
		current.AntigravityQuotaCooldownEnabled = boolPtr(*req.AntigravityQuotaCooldownEnabled)
	}
	if req.AccountActionsEnabled != nil {
		if s.cfg.AccountActionsEnvSet {
			return Status{}, errors.New("accountActionsEnabled is locked by environment variable")
		}
		current.AccountActionsEnabled = boolPtr(*req.AccountActionsEnabled)
	}
	if req.AccountActionsAutoDisable != nil {
		if s.cfg.AccountActionsAutoEnvSet {
			return Status{}, errors.New("accountActionsAutoDisable is locked by environment variable")
		}
		current.AccountActionsAutoDisable = boolPtr(*req.AccountActionsAutoDisable)
	}
	if req.CharityModelMonitorEnabled != nil {
		if s.cfg.CharityModelMonitorEnvSet {
			return Status{}, errors.New("charityModelMonitorEnabled is locked by environment variable")
		}
		current.CharityModelMonitorEnabled = boolPtr(*req.CharityModelMonitorEnabled)
	}
	if req.CharityModelMonitorIntervalMinutes != nil {
		current.CharityModelMonitorIntervalMinutes = intPtr(store.NormalizeCharityModelMonitorInterval(*req.CharityModelMonitorIntervalMinutes))
	}
	if req.CharityModelMonitorSites != nil {
		current.CharityModelMonitorSites = store.NormalizeCharityModelMonitorSites(req.CharityModelMonitorSites)
	}
	if req.HTTP500CooldownWindowMinutes != nil {
		current.HTTP500CooldownWindowMinutes = intPtr(store.NormalizeHTTP500CooldownWindowMinutes(*req.HTTP500CooldownWindowMinutes))
	}
	if req.HTTP500CooldownThreshold != nil {
		current.HTTP500CooldownThreshold = intPtr(store.NormalizeHTTP500CooldownThreshold(*req.HTTP500CooldownThreshold))
	}
	if req.HTTP500CooldownDurationMinutes != nil {
		current.HTTP500CooldownDurationMinutes = intPtr(store.NormalizeHTTP500CooldownDurationMinutes(*req.HTTP500CooldownDurationMinutes))
	}
	// SaveAutomationSettings returns the record it persisted (including the
	// UpdatedAtMS it assigned). We build the response from that record instead
	// of re-reading, so a transient read failure after a successful save cannot
	// cause the persisted state and runtime cache to diverge.
	saved, err := s.store.SaveAutomationSettings(ctx, current)
	if err != nil {
		return Status{}, err
	}
	s.mu.Lock()
	s.lastKnown = saved
	s.hasKnown = true
	s.mu.Unlock()
	return s.statusFromSettings(saved), nil
}

// RuntimeSettings returns the effective booleans used to gate runtime workers.
// It never blocks the collector loop on a read failure: it logs the error and
// keeps the last known-good configuration (or startup defaults before the first
// successful load).
func (s *Service) RuntimeSettings(ctx context.Context) RuntimeSettings {
	settings, _, err := s.loadSettings(ctx)
	if err != nil {
		log.Printf("[account-processing-policy] failed to load runtime settings: %v; using last known configuration", err)
		s.mu.RLock()
		cached, hasCached := s.lastKnown, s.hasKnown
		s.mu.RUnlock()
		if hasCached {
			return s.runtimeFromSettings(cached)
		}
		return s.runtimeFromSettings(store.AutomationSettings{})
	}
	s.mu.Lock()
	s.lastKnown = settings
	s.hasKnown = true
	s.mu.Unlock()
	return s.runtimeFromSettings(settings)
}

type RuntimeSettings struct {
	QuotaCooldownEnabled              bool
	AntigravityQuotaCooldownEnabled   bool
	AccountActionsEnabled             bool
	AccountActionsAutoDisable         bool
	CharityModelMonitorEnabled        bool
	CharityModelMonitorIntervalMinutes int
	CharityModelMonitorSites          []store.CharityModelMonitorSite
	HTTP500CooldownWindowMinutes      int
	HTTP500CooldownThreshold          int
	HTTP500CooldownDurationMinutes    int
}

func (s *Service) loadSettings(ctx context.Context) (store.AutomationSettings, bool, error) {
	if s == nil || s.store == nil {
		return store.AutomationSettings{}, false, nil
	}
	return s.store.LoadAutomationSettings(ctx)
}

type resolved struct {
	quotaValue, quotaLocked           bool
	quotaSource                       string
	antigravityValue, antigravityLocked bool
	antigravitySource                 string
	accountValue, accountLocked       bool
	accountSource                     string
	autoConfigured, autoLocked        bool
	autoSource                        string
	charityValue, charityLocked       bool
	charitySource                     string
}

func (s *Service) resolve(settings store.AutomationSettings) resolved {
	quotaValue, quotaSource, quotaLocked := s.resolveField(settings.QuotaCooldownEnabled, s.cfg.QuotaCooldownEnabled, s.cfg.QuotaCooldownEnvSet)
	antigravityValue, antigravitySource, antigravityLocked := s.resolveField(settings.AntigravityQuotaCooldownEnabled, s.cfg.AntigravityQuotaCooldownEnabled, s.cfg.AntigravityQuotaCooldownEnvSet)
	accountValue, accountSource, accountLocked := s.resolveField(settings.AccountActionsEnabled, s.cfg.AccountActionsEnabled, s.cfg.AccountActionsEnvSet)
	autoConfigured, autoSource, autoLocked := s.resolveField(settings.AccountActionsAutoDisable, s.cfg.AccountActionsAutoDisable, s.cfg.AccountActionsAutoEnvSet)
	charityValue, charitySource, charityLocked := s.resolveField(settings.CharityModelMonitorEnabled, s.cfg.CharityModelMonitorEnabled, s.cfg.CharityModelMonitorEnvSet)
	return resolved{
		quotaValue:        quotaValue,
		quotaSource:       quotaSource,
		quotaLocked:       quotaLocked,
		antigravityValue:  antigravityValue,
		antigravitySource: antigravitySource,
		antigravityLocked: antigravityLocked,
		accountValue:      accountValue,
		accountSource:     accountSource,
		accountLocked:     accountLocked,
		autoConfigured:    autoConfigured,
		autoSource:        autoSource,
		autoLocked:        autoLocked,
		charityValue:      charityValue,
		charitySource:     charitySource,
		charityLocked:     charityLocked,
	}
}

func (s *Service) statusFromSettings(settings store.AutomationSettings) Status {
	r := s.resolve(settings)
	autoEffective := r.accountValue && r.autoConfigured

	return Status{
		Source:                         overallSource(r.quotaSource, r.antigravitySource, r.accountSource, r.autoSource),
		UpdatedAtMS:                    settings.UpdatedAtMS,
		CharityModelMonitorIntervalMinutes: charityIntervalFromSettings(settings),
		CharityModelMonitorSites:       store.NormalizeCharityModelMonitorSites(settings.CharityModelMonitorSites),
		HTTP500CooldownWindowMinutes:   http500WindowFromSettings(settings),
		HTTP500CooldownThreshold:       http500ThresholdFromSettings(settings),
		HTTP500CooldownDurationMinutes: http500DurationFromSettings(settings),
		QuotaCooldown: Capability{
			Enabled:       r.quotaValue,
			Configured:    r.quotaValue,
			Source:        r.quotaSource,
			Locked:        r.quotaLocked,
			EnvKey:        "USAGE_QUOTA_COOLDOWN_ENABLED",
			ConfigFileKey: "quotaCooldownEnabled",
		},
		AntigravityQuotaCooldown: Capability{
			Enabled:       r.antigravityValue,
			Configured:    r.antigravityValue,
			Source:        r.antigravitySource,
			Locked:        r.antigravityLocked,
			EnvKey:        "USAGE_ANTIGRAVITY_QUOTA_COOLDOWN_ENABLED",
			ConfigFileKey: "antigravityQuotaCooldownEnabled",
		},
		AccountActions: Capability{
			Enabled:       r.accountValue,
			Configured:    r.accountValue,
			Source:        r.accountSource,
			Locked:        r.accountLocked,
			EnvKey:        "USAGE_ACCOUNT_ACTIONS_ENABLED",
			ConfigFileKey: "accountActionsEnabled",
		},
		AccountActionsAutoDisable: Capability{
			Enabled:       autoEffective,
			Configured:    r.autoConfigured,
			Source:        r.autoSource,
			Locked:        r.autoLocked,
			EnvKey:        "USAGE_ACCOUNT_ACTIONS_AUTO_DISABLE",
			ConfigFileKey: "accountActionsAutoDisable",
			DependsOn:     "authIssueQueue",
		},
		CharityModelMonitor: Capability{
			Configured:    settings.CharityModelMonitorEnabled != nil,
			Enabled:       r.charityValue,
			Locked:        r.charityLocked,
			Source:        r.charitySource,
			EnvKey:        "USAGE_CHARITY_MODEL_MONITOR_ENABLED",
			ConfigFileKey: "charityModelMonitorEnabled",
		},
	}
}

func (s *Service) runtimeFromSettings(settings store.AutomationSettings) RuntimeSettings {
	r := s.resolve(settings)
	return RuntimeSettings{
		QuotaCooldownEnabled:              r.quotaValue,
		AntigravityQuotaCooldownEnabled:   r.antigravityValue,
		AccountActionsEnabled:             r.accountValue,
		AccountActionsAutoDisable:         r.accountValue && r.autoConfigured,
		CharityModelMonitorEnabled:        r.charityValue,
		CharityModelMonitorIntervalMinutes: charityIntervalFromSettings(settings),
		CharityModelMonitorSites:          store.NormalizeCharityModelMonitorSites(settings.CharityModelMonitorSites),
		HTTP500CooldownWindowMinutes:      http500WindowFromSettings(settings),
		HTTP500CooldownThreshold:          http500ThresholdFromSettings(settings),
		HTTP500CooldownDurationMinutes:    http500DurationFromSettings(settings),
	}
}

func (s *Service) resolveField(dbValue *bool, startupValue bool, envLocked bool) (bool, string, bool) {
	if envLocked {
		return startupValue, SourceEnv, true
	}
	if dbValue != nil {
		return *dbValue, SourceDB, false
	}
	return startupValue, SourceStartup, false
}

func overallSource(sources ...string) string {
	hasDB := false
	hasEnv := false
	for _, source := range sources {
		switch source {
		case SourceDB:
			hasDB = true
		case SourceEnv:
			hasEnv = true
		}
	}
	if hasDB {
		return SourceDB
	}
	if hasEnv {
		return SourceEnv
	}
	return SourceStartup
}

func boolPtr(value bool) *bool {
	return &value
}

func intPtr(value int) *int {
	return &value
}

func charityIntervalFromSettings(settings store.AutomationSettings) int {
	if settings.CharityModelMonitorIntervalMinutes == nil {
		return store.NormalizeCharityModelMonitorInterval(0)
	}
	return store.NormalizeCharityModelMonitorInterval(*settings.CharityModelMonitorIntervalMinutes)
}

func http500WindowFromSettings(settings store.AutomationSettings) int {
	if settings.HTTP500CooldownWindowMinutes == nil {
		return store.NormalizeHTTP500CooldownWindowMinutes(0)
	}
	return store.NormalizeHTTP500CooldownWindowMinutes(*settings.HTTP500CooldownWindowMinutes)
}

func http500ThresholdFromSettings(settings store.AutomationSettings) int {
	if settings.HTTP500CooldownThreshold == nil {
		return store.NormalizeHTTP500CooldownThreshold(0)
	}
	return store.NormalizeHTTP500CooldownThreshold(*settings.HTTP500CooldownThreshold)
}

func http500DurationFromSettings(settings store.AutomationSettings) int {
	if settings.HTTP500CooldownDurationMinutes == nil {
		return store.NormalizeHTTP500CooldownDurationMinutes(0)
	}
	return store.NormalizeHTTP500CooldownDurationMinutes(*settings.HTTP500CooldownDurationMinutes)
}
