package grokinspection

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

type Repository interface {
	CreateRun(ctx context.Context, run model.GrokInspectionRun) (model.GrokInspectionRun, error)
	UpdateRun(ctx context.Context, run model.GrokInspectionRun) error
	InsertResult(ctx context.Context, result model.GrokInspectionResult) (model.GrokInspectionResult, error)
	InsertLog(ctx context.Context, entry model.GrokInspectionLog) (model.GrokInspectionLog, error)
	ListRuns(ctx context.Context, limit int) ([]model.GrokInspectionRun, error)
	GetRun(ctx context.Context, id int64) (model.GrokInspectionRun, bool, error)
	ListResults(ctx context.Context, runID int64) ([]model.GrokInspectionResult, error)
	ListLogs(ctx context.Context, runID int64) ([]model.GrokInspectionLog, error)
}

type repository struct {
	db *sql.DB
}

func New(db *sql.DB) Repository {
	return &repository{db: db}
}

func (r *repository) CreateRun(ctx context.Context, run model.GrokInspectionRun) (model.GrokInspectionRun, error) {
	now := time.Now().UnixMilli()
	if run.StartedAtMS <= 0 {
		run.StartedAtMS = now
	}
	if run.CreatedAtMS <= 0 {
		run.CreatedAtMS = now
	}
	run.UpdatedAtMS = now
	if run.Status == "" {
		run.Status = model.GrokInspectionStatusRunning
	}
	if run.SettingsJSON == "" {
		run.SettingsJSON = model.MarshalGrokInspectionSettings(run.Settings)
	}
	res, err := r.db.ExecContext(
		ctx,
		`insert into grok_inspection_runs (
			trigger_type, status, started_at_ms, finished_at_ms,
			total_files, probe_set_count, healthy_count, permission_count, quota_count,
			reauth_count, model_unavailable_count, probe_error_count, unknown_count,
			delete_count, disable_count, enable_count, keep_count, error,
			settings_json, created_at_ms, updated_at_ms
		) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.TriggerType,
		run.Status,
		run.StartedAtMS,
		nullPositiveInt64(run.FinishedAtMS),
		run.TotalFiles,
		run.ProbeSetCount,
		run.HealthyCount,
		run.PermissionCount,
		run.QuotaCount,
		run.ReauthCount,
		run.ModelUnavailCnt,
		run.ProbeErrorCount,
		run.UnknownCount,
		run.DeleteCount,
		run.DisableCount,
		run.EnableCount,
		run.KeepCount,
		nullString(run.Error),
		run.SettingsJSON,
		run.CreatedAtMS,
		run.UpdatedAtMS,
	)
	if err != nil {
		return model.GrokInspectionRun{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return model.GrokInspectionRun{}, err
	}
	run.ID = id
	return run, nil
}

func (r *repository) UpdateRun(ctx context.Context, run model.GrokInspectionRun) error {
	if run.ID <= 0 {
		return errors.New("grok inspection run id is required")
	}
	run.UpdatedAtMS = time.Now().UnixMilli()
	if run.SettingsJSON == "" {
		run.SettingsJSON = model.MarshalGrokInspectionSettings(run.Settings)
	}
	_, err := r.db.ExecContext(
		ctx,
		`update grok_inspection_runs set
			status = ?, finished_at_ms = ?, total_files = ?, probe_set_count = ?,
			healthy_count = ?, permission_count = ?, quota_count = ?, reauth_count = ?,
			model_unavailable_count = ?, probe_error_count = ?, unknown_count = ?,
			delete_count = ?, disable_count = ?, enable_count = ?, keep_count = ?,
			error = ?, settings_json = ?, updated_at_ms = ?
		where id = ?`,
		run.Status,
		nullPositiveInt64(run.FinishedAtMS),
		run.TotalFiles,
		run.ProbeSetCount,
		run.HealthyCount,
		run.PermissionCount,
		run.QuotaCount,
		run.ReauthCount,
		run.ModelUnavailCnt,
		run.ProbeErrorCount,
		run.UnknownCount,
		run.DeleteCount,
		run.DisableCount,
		run.EnableCount,
		run.KeepCount,
		nullString(run.Error),
		run.SettingsJSON,
		run.UpdatedAtMS,
		run.ID,
	)
	return err
}

func (r *repository) InsertResult(ctx context.Context, result model.GrokInspectionResult) (model.GrokInspectionResult, error) {
	if result.CreatedAtMS <= 0 {
		result.CreatedAtMS = time.Now().UnixMilli()
	}
	if result.ActionStatus == "" {
		result.ActionStatus = model.GrokInspectionActionStatusNone
	}
	res, err := r.db.ExecContext(
		ctx,
		`insert into grok_inspection_results (
			run_id, account_key, file_name, display_account, auth_index, provider, disabled,
			classification, action, action_reason, action_status, executed_action, action_error,
			status_code, model, error, created_at_ms
		) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		result.RunID,
		result.AccountKey,
		result.FileName,
		result.DisplayAccount,
		nullString(result.AuthIndex),
		result.Provider,
		boolToInt(result.Disabled),
		result.Classification,
		result.Action,
		result.ActionReason,
		result.ActionStatus,
		nullString(result.ExecutedAction),
		nullString(result.ActionError),
		nullIntPtr(result.StatusCode),
		nullString(result.Model),
		nullString(result.Error),
		result.CreatedAtMS,
	)
	if err != nil {
		return model.GrokInspectionResult{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return model.GrokInspectionResult{}, err
	}
	result.ID = id
	return result, nil
}

func (r *repository) InsertLog(ctx context.Context, entry model.GrokInspectionLog) (model.GrokInspectionLog, error) {
	if entry.CreatedAtMS <= 0 {
		entry.CreatedAtMS = time.Now().UnixMilli()
	}
	if entry.Level == "" {
		entry.Level = "info"
	}
	res, err := r.db.ExecContext(
		ctx,
		`insert into grok_inspection_logs (run_id, level, message, detail_json, created_at_ms)
		 values (?, ?, ?, ?, ?)`,
		entry.RunID,
		entry.Level,
		entry.Message,
		nullString(entry.DetailJSON),
		entry.CreatedAtMS,
	)
	if err != nil {
		return model.GrokInspectionLog{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return model.GrokInspectionLog{}, err
	}
	entry.ID = id
	return entry, nil
}

func (r *repository) ListRuns(ctx context.Context, limit int) ([]model.GrokInspectionRun, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := r.db.QueryContext(
		ctx,
		`select id, trigger_type, status, started_at_ms, coalesce(finished_at_ms, 0),
			total_files, probe_set_count, healthy_count, permission_count, quota_count,
			reauth_count, model_unavailable_count, probe_error_count, unknown_count,
			delete_count, disable_count, enable_count, keep_count, coalesce(error, ''),
			coalesce(settings_json, '{}'), created_at_ms, updated_at_ms
		 from grok_inspection_runs
		 order by started_at_ms desc, id desc
		 limit ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.GrokInspectionRun, 0)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

func (r *repository) GetRun(ctx context.Context, id int64) (model.GrokInspectionRun, bool, error) {
	row := r.db.QueryRowContext(
		ctx,
		`select id, trigger_type, status, started_at_ms, coalesce(finished_at_ms, 0),
			total_files, probe_set_count, healthy_count, permission_count, quota_count,
			reauth_count, model_unavailable_count, probe_error_count, unknown_count,
			delete_count, disable_count, enable_count, keep_count, coalesce(error, ''),
			coalesce(settings_json, '{}'), created_at_ms, updated_at_ms
		 from grok_inspection_runs where id = ?`,
		id,
	)
	run, err := scanRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.GrokInspectionRun{}, false, nil
	}
	if err != nil {
		return model.GrokInspectionRun{}, false, err
	}
	return run, true, nil
}

func (r *repository) ListResults(ctx context.Context, runID int64) ([]model.GrokInspectionResult, error) {
	rows, err := r.db.QueryContext(
		ctx,
		`select id, run_id, account_key, file_name, display_account, coalesce(auth_index, ''),
			provider, disabled, classification, action, action_reason,
			coalesce(action_status, 'none'), coalesce(executed_action, ''), coalesce(action_error, ''),
			status_code, coalesce(model, ''), coalesce(error, ''), created_at_ms
		 from grok_inspection_results
		 where run_id = ?
		 order by file_name asc, id asc`,
		runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.GrokInspectionResult, 0)
	for rows.Next() {
		var item model.GrokInspectionResult
		var disabled int
		var statusCode sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&item.RunID,
			&item.AccountKey,
			&item.FileName,
			&item.DisplayAccount,
			&item.AuthIndex,
			&item.Provider,
			&disabled,
			&item.Classification,
			&item.Action,
			&item.ActionReason,
			&item.ActionStatus,
			&item.ExecutedAction,
			&item.ActionError,
			&statusCode,
			&item.Model,
			&item.Error,
			&item.CreatedAtMS,
		); err != nil {
			return nil, err
		}
		item.Disabled = disabled != 0
		if statusCode.Valid {
			v := int(statusCode.Int64)
			item.StatusCode = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *repository) ListLogs(ctx context.Context, runID int64) ([]model.GrokInspectionLog, error) {
	rows, err := r.db.QueryContext(
		ctx,
		`select id, run_id, level, message, coalesce(detail_json, ''), created_at_ms
		 from grok_inspection_logs
		 where run_id = ?
		 order by created_at_ms asc, id asc`,
		runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.GrokInspectionLog, 0)
	for rows.Next() {
		var item model.GrokInspectionLog
		if err := rows.Scan(&item.ID, &item.RunID, &item.Level, &item.Message, &item.DetailJSON, &item.CreatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

type scannable interface {
	Scan(dest ...any) error
}

func scanRun(row scannable) (model.GrokInspectionRun, error) {
	var run model.GrokInspectionRun
	var finished sql.NullInt64
	if err := row.Scan(
		&run.ID,
		&run.TriggerType,
		&run.Status,
		&run.StartedAtMS,
		&finished,
		&run.TotalFiles,
		&run.ProbeSetCount,
		&run.HealthyCount,
		&run.PermissionCount,
		&run.QuotaCount,
		&run.ReauthCount,
		&run.ModelUnavailCnt,
		&run.ProbeErrorCount,
		&run.UnknownCount,
		&run.DeleteCount,
		&run.DisableCount,
		&run.EnableCount,
		&run.KeepCount,
		&run.Error,
		&run.SettingsJSON,
		&run.CreatedAtMS,
		&run.UpdatedAtMS,
	); err != nil {
		return model.GrokInspectionRun{}, err
	}
	if finished.Valid {
		run.FinishedAtMS = finished.Int64
	}
	run.Settings = model.UnmarshalGrokInspectionSettings(run.SettingsJSON)
	return run, nil
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullPositiveInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func nullIntPtr(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
