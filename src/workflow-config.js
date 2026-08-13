// Flexible reimbursement workflow v7.33
// แต่ละธุรกิจกำหนดได้ว่าจะมีด่านอนุมัติค่าใช้จ่าย / ตรวจเอกสารบัญชีหรือไม่
// ค่าเริ่มต้นเน้น SME: บัญชีตรวจเอกสารอย่างเดียว

export const REIMBURSEMENT_WORKFLOW_VERSION = "FLEX_REIMBURSEMENT_WORKFLOW_V7_33_20260813";

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "enabled", "เปิด", "ใช่"].includes(s)) return true;
  if (["false", "0", "no", "n", "off", "disabled", "ปิด", "ไม่"].includes(s)) return false;
  return Boolean(fallback);
}

export function reimbursementWorkflowConfig(settings = {}) {
  const approvalEnabled = boolValue(settings.expense_approval_enabled, false);
  const accountingReviewEnabled = boolValue(settings.accounting_review_enabled, true);
  const lineNotifyEnabled = boolValue(settings.line_workflow_notify_enabled, true);

  let preset = String(settings.reimbursement_workflow_preset || "").trim().toLowerCase();
  if (!preset || !["simple", "standard", "custom"].includes(preset)) {
    preset = approvalEnabled && accountingReviewEnabled
      ? "standard"
      : (!approvalEnabled && accountingReviewEnabled ? "simple" : "custom");
  }

  return {
    version: REIMBURSEMENT_WORKFLOW_VERSION,
    preset,
    approvalEnabled,
    accountingReviewEnabled,
    lineNotifyEnabled,
  };
}

export function initialExpenseWorkflowStatus(settingsOrConfig = {}) {
  const cfg = Object.prototype.hasOwnProperty.call(settingsOrConfig, "approvalEnabled")
    ? settingsOrConfig
    : reimbursementWorkflowConfig(settingsOrConfig);
  if (cfg.approvalEnabled) return "รออนุมัติค่าใช้จ่าย";
  if (cfg.accountingReviewEnabled) return "รอตรวจเอกสาร";
  return "รอโอนเงิน";
}

export function workflowStageFromStatus(status = "") {
  const s = String(status || "").trim();
  if (s === "รออนุมัติค่าใช้จ่าย") return "approval";
  if (["รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(s)) return "review";
  if (["ต้องแก้ไข", "ตีกลับ"].includes(s)) return "correction";
  if (["ไม่อนุมัติ", "ยกเลิก", "rejected", "Rejected"].includes(s)) return "rejected";
  if (s === "จ่ายแล้ว") return "paid";
  if (["รอโอนเงิน", "รอจ่าย", "รอหลักฐานการโอน", "อนุมัติแล้ว"].includes(s)) return "payment";
  if (s === "ขอเบิกด่วน") return "queue";
  return "queue";
}

export function workflowRoleForStage(stage = "") {
  if (stage === "approval") return "approver";
  if (stage === "review") return "accountant";
  return "";
}

export function workflowRoleLabel(role = "") {
  if (role === "approver") return "ผู้อนุมัติ";
  if (role === "accountant") return "ฝ่ายบัญชี";
  if (role === "owner") return "เจ้าของ";
  return role || "ผู้ใช้งาน";
}

export function actorCanHandleStage(actorRole = "", stage = "") {
  const role = String(actorRole || "").trim();
  if (!role || role === "owner") return true; // empty = internal LINE/system call
  if (stage === "approval") return role === "approver";
  if (stage === "review") return role === "accountant";
  return role === "accountant";
}

export function nextStatusAfterApproval(settingsOrConfig = {}) {
  const cfg = Object.prototype.hasOwnProperty.call(settingsOrConfig, "approvalEnabled")
    ? settingsOrConfig
    : reimbursementWorkflowConfig(settingsOrConfig);
  return cfg.accountingReviewEnabled ? "รอตรวจเอกสาร" : "รอโอนเงิน";
}
