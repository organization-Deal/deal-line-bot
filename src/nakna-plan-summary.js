/* Display-only plan metadata. Deliberately NO balances, usage counters, blocked
   flags, payment status decisions or write authorization in this response. */
export function buildNaknaPlanSummary(record, plans, now=Date.now()){
  if(!record||typeof record!=='object'||!plans?.free)throw new Error('invalid_plan_metadata');
  const end=Date.parse(record.trialEndsAt||'');
  const betaActive=record.status==='beta'&&Number.isFinite(end)&&end>now;
  const effectivePlan=betaActive?'business':(record.status==='active'&&plans[record.plan]?record.plan:'free');
  const plan=plans[effectivePlan]||plans.free;
  return {
    ok:true,summaryOnly:true,release:'NAKNA-ACCOUNTING-PERFORMANCE-1.2.0',
    status:betaActive?'beta':(record.status==='active'?'active':'free'),
    betaActive,effectivePlan,plan:betaActive?'beta':effectivePlan,
    planName:betaActive?'ทดลองใช้ Business ฟรี':plan.name,
    trialStartedAt:record.trialStartedAt||record.createdAt||'',
    trialEndsAt:record.trialEndsAt||'',
    daysRemaining:betaActive?Math.max(1,Math.ceil((end-now)/86400000)):0,
    cycle:record.cycle==='annual'?'annual':'monthly',
    businessLimit:Number(plan.businessLimit||1)
  };
}
