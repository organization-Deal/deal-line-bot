LINE Bot / Worker v6.0 — Dashboard Memory Support

Changes are backward compatible:
- /api/expenses?view=dashboard returns a compact expense projection for Dashboard only.
- /api/expenses without view=dashboard is unchanged.
- /api/income?reconciliation=0 skips loading bank reconciliation rows until Dashboard opens that feature.
- /api/income without the flag remains full response.
- No Sheet schema/data migration.

Deploy Worker first, Dashboard second.
Expected health version: DEAL_LINE_BOT_v6.0_DASHBOARD_MEMORY_20260809
