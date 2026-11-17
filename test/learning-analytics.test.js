'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {qualitySummary,qualityTrends,effectivenessSummary,createLearningAnalytics,normalizeWindow} = require('../src/learning-analytics');

test('quality reports actual reviewer distribution, per-dimension scores, unrated content, and coverage', () => {
  const result=qualitySummary(['1','2','3','4','5','6'],[
    {slotId:'1',feedbackType:'positive',ratings:{hook:5,language:4}},
    {slotId:'1',feedbackType:'positive',ratings:{hook:4}},
    {slotId:'2',feedbackType:'negative',ratings:{hook:2,cta:3}},
    {slotId:'3',feedbackType:'negative',ratings:{}},
    {slotId:'outside',feedbackType:'positive',ratings:{hook:5}},
  ]);
  assert.equal(result.status,'insufficient_data'); assert.equal(result.statusText,'Belum cukup data');
  assert.equal(result.eligibleCaptions,6); assert.equal(result.reviewedCaptions,3); assert.equal(result.unreviewedCaptions,3);
  assert.equal(result.feedbackCoverage,0.5); assert.equal(result.feedbackSubmissions,4); assert.equal(result.unratedFeedback,1);
  assert.equal(result.positiveFeedbackShare,0.5); assert.equal(result.negativeFeedbackShare,0.5);
  assert.equal(result.dimensions.hook.average,11/3); assert.equal(result.dimensions.hook.count,3);
  assert.equal(result.dimensions.hook.captionSampleSize,2); assert.equal(result.dimensions.hook.smallSample,true);
  assert.equal(result.dimensions.language.average,4); assert.equal(result.dimensions.cta.average,3);
});

test('quality monthly trends use published caption cohort and preserve missing dimension values', () => {
  const trends=qualityTrends([
    {id:1,completedAt:'2026-01-15T00:00:00.000Z'},
    {id:2,completedAt:'2026-02-03T00:00:00.000Z'},
  ],[
    {slotId:'1',feedbackType:'positive',ratings:{hook:5},completedAt:'2026-01-15T00:00:00.000Z'},
  ]);
  assert.equal(trends.length,2);
  assert.deepEqual(trends[0],{
    month:'2026-01',eligibleCaptions:1,reviewedCaptions:1,feedbackCoverage:1,feedbackSubmissions:1,
    positiveFeedbackSubmissions:1,negativeFeedbackSubmissions:0,
    dimensionAverages:{hook:{count:1,captionSampleSize:1,average:5},creativity:{count:0,captionSampleSize:0,average:null},language:{count:0,captionSampleSize:0,average:null},relevance:{count:0,captionSampleSize:0,average:null},brandVoice:{count:0,captionSampleSize:0,average:null},clarity:{count:0,captionSampleSize:0,average:null},diversity:{count:0,captionSampleSize:0,average:null},cta:{count:0,captionSampleSize:0,average:null}},
  });
  assert.equal(trends[1].reviewedCaptions,0); assert.equal(trends[1].feedbackCoverage,0);
});

test('effectiveness is attributed to exact applied rule version and reports observational sample/confounder limits', () => {
  const activation=new Date('2026-03-15T00:00:00.000Z'); const from=new Date('2026-03-01T00:00:00.000Z'); const to=new Date('2026-05-01T00:00:00.000Z');
  const snapshots=[]; const attempts=[];
  for(let i=0;i<20;i++){
    const baseline=i<10; const id=`a-${i}`; const slotId=`s-${i}`;
    snapshots.push({attempt_id:id,slot_id:slotId,model_id:'provider/model',configuration_version:'9',product_category:'topup',content_topic:'community',prompt_integration_enabled:!baseline,facts_version_json:[{id:'fact-1',updatedAt:'2026-03-01'}],applied_rules_json:baseline?[]:[{id:'12',version:3},{id:'19',version:1}],retrieval_context_json:{validationContractVersion:'validation-v1'},created_at:baseline?new Date(activation.getTime()-(10-i)*86400000):new Date(activation.getTime()+(i-9)*86400000),slot_status:'published'});
    attempts.push({attempt_id:id,ordinal:1,state:baseline?i<3?'contextual_failed':'passed':i<12?'contextual_failed':'passed',failure_codes:baseline&&i<3?['REPETITIVE_CAPTION']:!baseline&&i<12?['REPETITIVE_CAPTION']:[]});
  }
  const report=effectivenessSummary({
    rules:[{rule_id:'12',version:3,product_category:'topup',content_topic:'community',failure_code:'REPETITIVE_CAPTION'}],
    actions:[{rule_id:'12',version:3,action:'activated',created_at:activation}],snapshots,attempts,feedbackRows:[],from,to,
  });
  const comparison=report.comparisons[0];
  assert.equal(report.causalClaim,false); assert.equal(comparison.status,'observational');
  assert.equal(comparison.baseline.sampleSize,10); assert.equal(comparison.observed.sampleSize,10);
  assert.equal(comparison.baseline.contextualFailureRate,0.3); assert.equal(comparison.observed.contextualFailureRate,0.2);
  assert.equal(comparison.relevantFailureCategory,'REPETITIVE_CAPTION');
  assert.equal(comparison.baseline.relevantFailureRate,0.3); assert.equal(comparison.observed.relevantFailureRate,0.2);
  assert.equal(comparison.confounders.validatorChanged,false);
  assert.equal(comparison.failureRateDifference,-0.1);
  assert.equal(comparison.baseline.attributedAttempts,10);
  assert.equal(comparison.baseline.firstAttemptOutcomeSampleSize,10);
  assert.equal(comparison.baseline.generations,undefined);
  assert.deepEqual(comparison.coAppliedRules,[{ruleId:'19',version:1,generations:10}]);
  assert.equal(comparison.baseline.quality.statusText,'Belum cukup data');
});

test('effectiveness recognizes legacy and current guideline fingerprints as confounders',()=>{
  const activation=new Date('2026-03-15T00:00:00Z');
  const snapshots=[];const attempts=[];
  for(let i=0;i<20;i++){
    const baseline=i<10;const id=`g-${i}`;
    snapshots.push({attempt_id:id,slot_id:`gs-${i}`,model_id:'m',configuration_version:'1',product_category:'all',content_topic:'all',
      prompt_integration_enabled:!baseline,applied_rules_json:baseline?[]:[{id:'4',version:1}],created_at:baseline?new Date(activation.getTime()-86400000):new Date(activation.getTime()+86400000),
      retrieval_context_json:{brandGuidelinesHash:baseline?'before':'after',adminGuidelinesHash:'same',validationContractVersion:'validation-v1'}});
    attempts.push({attempt_id:id,ordinal:1,state:'passed'});
  }
  const report=effectivenessSummary({rules:[{rule_id:'4',version:1,product_category:'all',content_topic:'all'}],actions:[{rule_id:'4',version:1,action:'activated',created_at:activation}],snapshots,attempts,feedbackRows:[],from:new Date('2026-03-01'),to:new Date('2026-05-01')});
  assert.equal(report.comparisons[0].confounders.guidelinesChanged,true);
});

test('effectiveness uses Belum cukup data below the minimum for either arm', () => {
  const report=effectivenessSummary({rules:[{rule_id:'1',version:1,product_category:'all',content_topic:'all'}],actions:[{rule_id:'1',version:1,action:'activated',created_at:'2026-01-15T00:00:00Z'}],snapshots:[],attempts:[],feedbackRows:[],from:new Date('2026-01-01'),to:new Date('2026-02-01')});
  assert.equal(report.statusText,'Belum cukup data'); assert.equal(report.comparisons[0].minimumPerArm,10);
});

test('effectiveness stays incomplete when validation-contract attribution is missing',()=>{
  const activation=new Date('2026-03-15T00:00:00Z');const snapshots=[];const attempts=[];
  for(let i=0;i<20;i++){
    const baseline=i<10;const id=`legacy-${i}`;
    snapshots.push({attempt_id:id,slot_id:`legacy-slot-${i}`,model_id:'m',configuration_version:'1',product_category:'all',content_topic:'all',
      prompt_integration_enabled:!baseline,applied_rules_json:baseline?[]:[{id:'6',version:1}],created_at:baseline?new Date(activation.getTime()-86400000):new Date(activation.getTime()+86400000)});
    attempts.push({attempt_id:id,ordinal:1,state:'passed'});
  }
  const report=effectivenessSummary({rules:[{rule_id:'6',version:1,product_category:'all',content_topic:'all'}],actions:[{rule_id:'6',version:1,action:'activated',created_at:activation}],snapshots,attempts,feedbackRows:[],from:new Date('2026-03-01'),to:new Date('2026-05-01')});
  assert.equal(report.comparisons[0].confounders.validatorVersionMissing,true);
  assert.equal(report.comparisons[0].status,'insufficient_data');
});

test('effectiveness minimum counts only evaluated passed or contextual outcomes', () => {
  const activation=new Date('2026-03-15T00:00:00.000Z'); const from=new Date('2026-03-01T00:00:00.000Z'); const to=new Date('2026-05-01T00:00:00.000Z');
  const snapshots=[]; const attempts=[];
  for(let i=0;i<20;i++){
    const baseline=i<10; const id=`x-${i}`;
    snapshots.push({attempt_id:id,slot_id:`xs-${i}`,model_id:'model',configuration_version:'1',product_category:'all',content_topic:'all',prompt_integration_enabled:!baseline,applied_rules_json:baseline?[]:[{id:'2',version:1}],retrieval_context_json:{validationContractVersion:'validation-v1'},created_at:baseline?new Date(activation.getTime()-86400000):new Date(activation.getTime()+86400000)});
    attempts.push({attempt_id:id,ordinal:1,state:i<6?'passed':i<10?'technical_failed':i<16?'passed':'unknown'});
  }
  const report=effectivenessSummary({rules:[{rule_id:'2',version:1,product_category:'all',content_topic:'all'}],actions:[{rule_id:'2',version:1,action:'activated',created_at:activation}],snapshots,attempts,feedbackRows:[],from,to});
  assert.equal(report.comparisons[0].baseline.sampleSize,10);
  assert.equal(report.comparisons[0].baseline.evaluatedSampleSize,6);
  assert.equal(report.comparisons[0].status,'insufficient_data');
});

test('effectiveness closes a version on the next activation and only counts prompt-integrated treatment', () => {
  const activation=new Date('2026-03-15T00:00:00.000Z'); const switchAt=new Date('2026-04-01T00:00:00.000Z');
  const snapshots=[]; const attempts=[];
  for(let i=0;i<20;i++){
    const first=i<10; const id=`z-${i}`; const at=first?new Date(activation.getTime()+86400000):new Date(switchAt.getTime()+86400000);
    snapshots.push({attempt_id:id,slot_id:`zs-${i}`,model_id:'m',configuration_version:'1',product_category:'all',content_topic:'all',prompt_integration_enabled:!first,applied_rules_json:first?[]:[{id:'8',version:2}],retrieval_context_json:{validationContractVersion:'validation-v1'},created_at:at});
    attempts.push({attempt_id:id,ordinal:1,state:'passed'});
  }
  const report=effectivenessSummary({rules:[{rule_id:'8',version:1,product_category:'all',content_topic:'all'},{rule_id:'8',version:2,product_category:'all',content_topic:'all'}],actions:[{rule_id:'8',version:1,action:'activated',created_at:activation},{rule_id:'8',version:2,action:'activated',created_at:switchAt}],snapshots,attempts,feedbackRows:[],from:new Date('2026-03-01'),to:new Date('2026-05-01')});
  assert.equal(report.comparisons[0].deactivatedAt,switchAt.toISOString());
  assert.equal(report.comparisons[0].observed.sampleSize,0);
  assert.equal(report.comparisons[1].observed.sampleSize,10);
});

test('database compliance reads independent claim population and discloses missing, unknown, technical, stages, and categories', async () => {
  const queries=[];
  const pool={execute:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('COUNT(*) AS eligible'))return [[{eligible:'6'}]];
    return [[
      {slotId:'s1',attemptId:'a1',ordinal:1,state:'passed',deterministicOutcome:'PASSED',semanticOutcome:'PASSED',failureCodes:[]},
      {slotId:'s2',attemptId:'a2',ordinal:1,state:'contextual_failed',deterministicOutcome:'FAILED',semanticOutcome:'NOT_RUN',failureCodes:['REPETITIVE_CAPTION']},
      {slotId:'s3',attemptId:'a3',ordinal:1,state:'technical_failed',deterministicOutcome:'PASSED',semanticOutcome:'TECHNICAL_FAILED',failureCodes:[]},
      {slotId:'s4',attemptId:'a4',ordinal:1,state:'unknown',deterministicOutcome:'PASSED',semanticOutcome:'UNKNOWN',failureCodes:[]},
      {slotId:'s5',attemptId:'a5',ordinal:1,state:'validating',deterministicOutcome:'IN_PROGRESS',semanticOutcome:'NOT_RUN',failureCodes:[]},
      {slotId:'s6',attemptId:null,ordinal:null,state:null,deterministicOutcome:null,semanticOutcome:null,failureCodes:null},
    ]];
  }};
  const analytics=createLearningAnalytics(pool,{clock:()=>new Date('2026-11-10T00:00:00Z')});
  const report=await analytics.compliance({from:'2026-11-01T00:00:00Z',to:'2026-11-10T00:00:00Z'});
  assert.equal(report.definitionVersion,'compliance-v3');
  assert.equal(report.eligibleFirstAttempts,6); assert.equal(report.firstPassDenominator,5);
  assert.equal(report.evaluatedFirstAttempts,2); assert.equal(report.firstPassSuccesses,1); assert.equal(report.contextualFailures,1);
  assert.equal(report.firstPassApprovalRate,0.2); assert.equal(report.contextualRejectionRate,0.2);
  assert.equal(report.technicalExclusions,1); assert.equal(report.unknownOutcomes,1);
  assert.equal(report.incompleteOutcomes,1); assert.equal(report.missingAttempts,1); assert.equal(report.status,'incomplete');
  assert.equal(report.failureCategories.REPETITIVE_CAPTION,1); assert.ok(queries[1].sql.includes('generation_slot_claims'));
});

test('truncated compliance rows withhold partial success rates and coverage', async () => {
  const pool={execute:async(sql)=>sql.includes('COUNT(*) AS eligible')?[[{eligible:'30000'}]]:[Array.from({length:20001},(_,i)=>({slotId:`s${i}`,attemptId:`a${i}`,ordinal:1,state:'passed',deterministicOutcome:'PASSED',semanticOutcome:'PASSED',failureCodes:[]}))]};
  const report=await createLearningAnalytics(pool,{clock:()=>new Date('2026-11-10T00:00:00Z')}).compliance({from:'2026-11-01',to:'2026-11-10'});
  assert.equal(report.truncated,true); assert.equal(report.firstPassDenominator,null); assert.equal(report.firstPassApprovalRate,null);
  assert.equal(report.contextualRejectionRate,null); assert.equal(report.attemptRecordCoverage,null);
});

test('technical first attempts are excluded and a zero primary denominator is unavailable', async () => {
  const pool={execute:async(sql)=>sql.includes('COUNT(*) AS eligible')?[[{eligible:'5'}]]:[Array.from({length:5},(_,index)=>({
    slotId:`s${index}`,attemptId:`a${index}`,ordinal:1,state:'technical_failed',
    deterministicOutcome:'PASSED',semanticOutcome:'TECHNICAL_FAILED',failureCodes:[],
  }))]};
  const report=await createLearningAnalytics(pool,{clock:()=>new Date('2026-11-10T00:00:00Z')}).compliance({from:'2026-11-01',to:'2026-11-10'});
  assert.equal(report.firstPassDenominator,0);
  assert.equal(report.technicalExclusions,5);
  assert.equal(report.firstPassApprovalRate,null);
  assert.equal(report.contextualRejectionRate,null);
});

test('quality reads published slots and caption-matched reviews; empty populations remain unavailable', async () => {
  const statements=[];
  const pool={execute:async(sql,args)=>{
    statements.push(sql);
    if(sql.includes('SELECT id,completed_at'))return [[{id:1,completedAt:new Date('2026-01-10T00:00:00Z')},{id:2,completedAt:new Date('2026-01-11T00:00:00Z')}]];
    return [[{slotId:1,reviewerId:99,feedbackType:'positive',ratings:{hook:5},createdAt:new Date('2026-01-12T00:00:00Z')}]];
  }};
  const analytics=createLearningAnalytics(pool,{clock:()=>new Date('2026-02-01T00:00:00Z')});
  const report=await analytics.quality({from:'2026-01-01T00:00:00Z',to:'2026-02-01T00:00:00Z'});
  assert.equal(report.eligibleCaptions,2); assert.equal(report.reviewedCaptions,1); assert.equal(report.feedbackCoverage,0.5);
  assert.equal(report.positiveFeedbackSubmissions,1); assert.equal(report.dimensions.hook.average,5); assert.equal(report.statusText,'Belum cukup data');
  assert.ok(statements[1].includes('caption_hash=SHA2(s.caption,256)'));
});

test('quality counts actual multi-reviewer submissions but coverage counts captions and unrated feedback stays unrated',()=>{
  const report=qualitySummary(['slot-1','slot-2'],[
    {slotId:'slot-1',reviewerId:'admin-a',feedbackType:'positive',ratings:{hook:5,language:4}},
    {slotId:'slot-1',reviewerId:'admin-b',feedbackType:'negative',ratings:{hook:3}},
    {slotId:'slot-2',reviewerId:'admin-a',feedbackType:'positive',ratings:{}},
  ]);
  assert.equal(report.reviewedCaptions,2);
  assert.equal(report.feedbackSubmissions,3);
  assert.equal(report.feedbackCoverage,1);
  assert.equal(report.positiveFeedbackSubmissions,2);
  assert.equal(report.negativeFeedbackSubmissions,1);
  assert.equal(report.unratedFeedback,1);
  assert.equal(report.dimensions.hook.average,4);
  assert.equal(report.dimensions.hook.count,2);
  assert.equal(report.dimensions.hook.captionSampleSize,1);
  assert.equal(report.dimensions.hook.smallSample,true);
});

test('analytics rejects inverted or unbounded time ranges', () => {
  assert.throws(()=>normalizeWindow({from:'2026-02-01',to:'2026-01-01'}),{code:'INVALID_ANALYTICS_WINDOW'});
  assert.throws(()=>normalizeWindow({from:'2024-01-01',to:'2026-01-01'}),{code:'INVALID_ANALYTICS_WINDOW'});
});
