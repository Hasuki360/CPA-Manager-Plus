package model

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	DefaultCharityModelMonitorIntervalMinutes = 15
	MinCharityModelMonitorIntervalMinutes     = 5
	MaxCharityModelMonitorIntervalMinutes     = 1440
)

type CharityModelMonitorSite struct {
	Key                  string `json:"key"`
	Name                 string `json:"name"`
	Enabled              bool   `json:"enabled"`
	PricingURL           string `json:"pricingUrl,omitempty"`
	Referer              string `json:"referer,omitempty"`
	CodexProviderSection string `json:"codexProviderSection,omitempty"`
	CodexBaseURL         string `json:"codexBaseUrl,omitempty"`
	ClaudeProviderSection string `json:"claudeProviderSection,omitempty"`
	ClaudeBaseURL        string `json:"claudeBaseUrl,omitempty"`
	MonitorGPT           bool   `json:"monitorGpt"`
	MonitorClaude        bool   `json:"monitorClaude"`
	SyncCodexHeadersOnly bool   `json:"syncCodexHeadersOnly,omitempty"`
}

type CharityModelMonitorProviderState struct {
	Site           string            `json:"site"`
	Label          string            `json:"label"`
	Section        string            `json:"section"`
	Provider       string            `json:"provider"`
	DesiredEnabled bool              `json:"desiredEnabled"`
	Changed        bool              `json:"changed"`
	SwitchChanged  bool              `json:"switchChanged"`
	HeadersChanged bool              `json:"headersChanged"`
	AfterEnabled   []bool            `json:"afterEnabled,omitempty"`
	DesiredHeaders map[string]string `json:"desiredHeaders,omitempty"`
	CheckMode      string            `json:"checkMode,omitempty"`
	CustomModels   []string          `json:"customModels,omitempty"`
	MatchedModels  []string          `json:"matchedModels,omitempty"`
	Reason         string            `json:"reason,omitempty"`
}

type CharityModelMonitorSiteState struct {
	Name             string   `json:"name"`
	LastTotalModels  int      `json:"lastTotalModels"`
	LastTargetModels []string `json:"lastTargetModels,omitempty"`
	LastGPTModels    []string `json:"lastGptModels,omitempty"`
	LastClaudeModels []string `json:"lastClaudeModels,omitempty"`
	PricingVersion   string   `json:"pricingVersion,omitempty"`
}

type CharityModelMonitorState struct {
	UpdatedAtMS             int64                                      `json:"updatedAtMs,omitempty"`
	LastCheck               string                                     `json:"lastCheck,omitempty"`
	LastTotalModels         int                                        `json:"lastTotalModels,omitempty"`
	LastCodexCLIVersion     string                                     `json:"lastCodexCliVersion,omitempty"`
	LastCodexVersionChecked int64                                      `json:"lastCodexVersionCheckedAtMs,omitempty"`
	Seen                    []string                                   `json:"seen,omitempty"`
	Sites                   map[string]CharityModelMonitorSiteState    `json:"sites,omitempty"`
	LastProviderSync        []CharityModelMonitorProviderState         `json:"lastProviderSync,omitempty"`
	LastProviderError       []string                                   `json:"lastProviderError,omitempty"`
}

func DefaultCharityModelMonitorSites() []CharityModelMonitorSite {
	return []CharityModelMonitorSite{
		{
			Key:                  "x666",
			Name:                 "薄荷公益站",
			Enabled:              true,
			PricingURL:           "https://x666.me/api/pricing",
			Referer:              "https://x666.me/pricing",
			CodexProviderSection: "codex-api-key",
			CodexBaseURL:         "https://x666.me/v1",
			ClaudeProviderSection: "claude-api-key",
			ClaudeBaseURL:        "https://x666.me",
			MonitorGPT:           true,
			MonitorClaude:        true,
		},
		{
			Key:                  "muyuan",
			Name:                 "君の的公益",
			Enabled:              true,
			PricingURL:           "https://muyuan.do/api/pricing",
			Referer:              "https://muyuan.do/pricing",
			CodexProviderSection: "codex-api-key",
			CodexBaseURL:         "https://muyuan.do/v1",
			ClaudeProviderSection: "claude-api-key",
			ClaudeBaseURL:        "https://muyuan.do",
			MonitorGPT:           true,
			MonitorClaude:        true,
		},
		{
			Key:                  "anyrouter",
			Name:                 "AnyRouter",
			Enabled:              true,
			Referer:              "https://anyrouter.top",
			CodexProviderSection: "codex-api-key",
			CodexBaseURL:         "https://anyrouter.top/v1",
			SyncCodexHeadersOnly: true,
		},
	}
}

func NormalizeCharityModelMonitorInterval(value int) int {
	if value <= 0 {
		return DefaultCharityModelMonitorIntervalMinutes
	}
	if value < MinCharityModelMonitorIntervalMinutes {
		return MinCharityModelMonitorIntervalMinutes
	}
	if value > MaxCharityModelMonitorIntervalMinutes {
		return MaxCharityModelMonitorIntervalMinutes
	}
	return value
}

func NormalizeCharityModelMonitorSites(sites []CharityModelMonitorSite) []CharityModelMonitorSite {
	if sites == nil {
		sites = DefaultCharityModelMonitorSites()
	}
	result := make([]CharityModelMonitorSite, 0, len(sites))
	seen := map[string]int{}
	for i, site := range sites {
		site.Key = strings.TrimSpace(site.Key)
		site.Name = strings.TrimSpace(site.Name)
		site.PricingURL = strings.TrimSpace(site.PricingURL)
		site.Referer = strings.TrimSpace(site.Referer)
		site.CodexProviderSection = stringFallback(strings.TrimSpace(site.CodexProviderSection), "codex-api-key")
		site.CodexBaseURL = strings.TrimSpace(site.CodexBaseURL)
		site.ClaudeProviderSection = stringFallback(strings.TrimSpace(site.ClaudeProviderSection), "claude-api-key")
		site.ClaudeBaseURL = strings.TrimSpace(site.ClaudeBaseURL)
		if site.Name == "" {
			site.Name = fmt.Sprintf("公益站 %d", i+1)
		}
		if site.Key == "" {
			site.Key = slugKey(site.Name)
		}
		if site.Key == "" {
			site.Key = fmt.Sprintf("site-%d", i+1)
		}
		if n := seen[site.Key]; n > 0 {
			site.Key = fmt.Sprintf("%s-%d", site.Key, n+1)
		}
		seen[site.Key]++
		result = append(result, site)
	}
	return result
}

func stringFallback(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func slugKey(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(value, "-")
	return strings.Trim(value, "-")
}
