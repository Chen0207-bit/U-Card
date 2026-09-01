import { failure, ok } from '../../api/response.js';

export function createComplianceService(port) {
  const presentKyb = item => ({
    ...item,
    statusLabel: port.kybStatusLabels[item.status],
    uboCount: (item.ubos || []).length,
  });

  const presentCase = item => ({ ...item, typeLabel: port.caseTypeLabels[item.type] });

  return {
    kyc() {
      const list = port.users().map(user => {
        const docs = port.userDocs().filter(doc => doc.userId === user.id);
        const linked = port.approvals()
          .filter(approval => approval.type === 'kyc_upgrade' && approval.payload && approval.payload.userId === user.id)
          .map(approval => ({
            id: approval.id,
            title: approval.title,
            status: approval.status,
            statusLabel: { pending: '审批中', approved: '已通过', rejected: '已驳回', cancelled: '已撤回' }[approval.status] || approval.status,
            createdAt: approval.createdAt,
          }));
        const limit = port.kycLimits[user.kycLevel] || { perTx: 0, perDay: 0 };
        const trail = [{
          ts: user.createdAt,
          node: '开户建档',
          note: `初始 KYC L${user.kycLevel} · ${user.kycLevel === 0 ? '基础档(免证件, 低限额)' : '证件已核验'}`,
          operator: '系统',
        }];
        docs.forEach(doc => trail.push({
          ts: doc.createdAt,
          node: '证件提交',
          note: `${doc.typeLabel} ${doc.number} · 有效期至 ${port.isoDay(doc.expiry)}`,
          operator: '客户',
        }));
        if (user.kycStatus === 'pending_upgrade') trail.push({
          ts: port.daysAgo(2, 6),
          node: '申请升级',
          note: '提交升级材料, 已转审批中心「KYC 升级」流程',
          operator: '客户',
        });
        linked.forEach(approval => trail.push({
          ts: approval.createdAt,
          node: '审批流转',
          note: `${approval.title} · ${approval.statusLabel}`,
          operator: '审批中心',
        }));
        return {
          userId: user.id,
          name: user.name,
          country: user.country,
          cc: user.cc,
          city: user.city,
          kycLevel: user.kycLevel,
          kycLevelLabel: ['L0 基础档', 'L1 初级', 'L2 高级'][user.kycLevel] || `L${user.kycLevel}`,
          kycStatus: user.kycStatus,
          statusLabel: user.kycStatus === 'approved' ? '已认证' : '升级审核中',
          levelBand: user.kycLevel === 2 ? 'high' : user.kycLevel === 1 ? 'mid' : 'low',
          perTxLimit: limit.perTx,
          perDayLimit: limit.perDay,
          docs: docs.map(doc => ({ ...doc, expiryDay: port.isoDay(doc.expiry), daysLeft: Math.ceil((doc.expiry - port.now()) / 864e5) })),
          trail,
          linkedApprovals: linked,
        };
      });
      const countBand = band => list.filter(item => item.levelBand === band).length;
      return ok({
        list,
        summary: {
          total: list.length,
          low: countBand('low'),
          mid: countBand('mid'),
          high: countBand('high'),
          pendingUpgrade: list.filter(item => item.kycStatus === 'pending_upgrade').length,
        },
        note: 'KYC 升级审批在「审批中心 → kyc_upgrade」流程中处理, 通过后等级与限额自动生效',
      });
    },

    kyb() {
      const cases = port.kybCases();
      const count = status => cases.filter(item => item.status === status).length;
      return ok({
        list: cases.map(presentKyb),
        summary: {
          total: cases.length,
          pending: count('pending'),
          approved: count('approved'),
          rejected: count('rejected'),
          info_required: count('info_required'),
          ubos: cases.reduce((sum, item) => sum + (item.ubos || []).length, 0),
          pepUbos: cases.reduce((sum, item) => sum + (item.ubos || []).filter(ubo => ubo.pep).length, 0),
        },
      });
    },

    actOnKyb(id, body = {}, actorId) {
      const item = port.kybCases().find(candidate => candidate.id === id);
      if (!item) return failure(404, 'KYB 案件不存在');
      const action = String(body.action || '');
      const allowed = { pending: ['approve', 'reject', 'request_info'], info_required: ['approve', 'reject'], approved: [], rejected: [] };
      if (!(allowed[item.status] || []).includes(action)) {
        const names = { approve: '通过', reject: '驳回', request_info: '要求补充材料' };
        return failure(409, `当前状态「${port.kybStatusLabels[item.status]}」不允许${names[action] || action}, 允许: ${(allowed[item.status] || []).join(' / ') || '无(已终态)'}`);
      }
      const reason = String(body.reason || '').trim();
      if ((action === 'reject' || action === 'request_info') && !reason) return failure(400, `${action === 'reject' ? '驳回' : '要求补充材料'}必须填写原因`);
      const node = { approve: '终审通过', reject: '终审驳回', request_info: '要求补充材料' };
      const note = { approve: 'KYB 审核通过, 开通企业钱包与批量发卡资格', reject: `驳回: ${reason}`, request_info: `补充材料: ${reason}` };
      item.status = { approve: 'approved', reject: 'rejected', request_info: 'info_required' }[action];
      item.reviewedAt = port.now();
      item.timeline.push({ ts: port.now(), node: node[action], note: note[action], operator: port.operatorName(actorId) });
      return ok({ case: presentKyb(item) });
    },

    screen(body = {}) {
      const name = String(body.name || '').trim();
      if (!name) return failure(400, '请填写筛查姓名');
      return ok(port.screenName(name, String(body.country || '').toUpperCase()));
    },

    screenings() {
      const list = port.complianceScreenings();
      const hit = list.filter(item => item.hits.length);
      return ok({
        list,
        summary: {
          total: list.length,
          hit: hit.length,
          clean: list.length - hit.length,
          sanctionHits: hit.filter(item => item.hits.some(match => match.kind === 'sanction')).length,
          pepHits: hit.filter(item => item.hits.some(match => match.kind === 'pep')).length,
          high: hit.filter(item => item.grade === 'high').length,
          mid: hit.filter(item => item.grade === 'mid').length,
          low: hit.filter(item => item.grade === 'low').length,
        },
        note: '模糊匹配口径: 精确/包含/别名/词元 + 同国家加成',
      });
    },

    sanctions(query = {}) {
      const all = port.sanctions();
      const keyword = String(query.kw || '').toLowerCase();
      const list = keyword ? all.filter(item => item.name.toLowerCase().includes(keyword)
        || (item.aliases || []).some(alias => alias.toLowerCase().includes(keyword))
        || item.country.toLowerCase() === keyword
        || item.listSource.toLowerCase() === keyword) : all;
      return ok({
        list,
        summary: {
          total: all.length,
          individual: all.filter(item => item.type === 'individual').length,
          entity: all.filter(item => item.type === 'entity').length,
          ofac: all.filter(item => item.listSource === 'OFAC').length,
          eu: all.filter(item => item.listSource === 'EU').length,
          un: all.filter(item => item.listSource === 'UN').length,
        },
      });
    },

    peps(query = {}) {
      const all = port.peps();
      const keyword = String(query.kw || '').toLowerCase();
      const list = keyword ? all.filter(item => item.name.toLowerCase().includes(keyword)
        || item.position.toLowerCase().includes(keyword)
        || item.country.toLowerCase() === keyword) : all;
      const count = level => all.filter(item => item.level === level).length;
      return ok({ list, summary: { total: all.length, high: count('high'), medium: count('medium'), low: count('low') } });
    },

    strReports() {
      const reports = port.strReports();
      const count = status => reports.filter(report => report.status === status).length;
      return ok({
        list: [...reports].sort((a, b) => b.createdAt - a.createdAt).map(report => {
          const user = port.users().find(item => item.id === report.userId);
          return {
            ...report,
            statusLabel: port.strStatusLabels[report.status],
            userName: user ? user.name : `用户 #${report.userId}`,
            userCountry: user ? user.country : '—',
          };
        }),
        summary: { total: reports.length, draft: count('draft'), submitted: count('submitted'), closed: count('closed') },
      });
    },

    createStr(body = {}) {
      const event = body.riskEventId != null ? port.riskEvents().find(item => item.id === +body.riskEventId) : null;
      if (!event) return failure(404, `风险事件不存在: ${body.riskEventId == null ? '(未传 riskEventId)' : body.riskEventId}, 请在「风控中心 → 风险事件」选择`);
      const rule = port.engineRules().find(item => item.id === event.ruleId);
      const reports = port.strReports();
      const report = {
        id: port.nextId(),
        refNo: `STR-${new Date().getFullYear()}-${String(41 + reports.length).padStart(4, '0')}`,
        userId: event.userId,
        triggerRule: rule ? `R${rule.id} ${rule.name}` : (event.reason || '风控规则'),
        triggerEventId: event.id,
        amount: event.amount || 0,
        status: 'draft',
        note: `由风险事件 #${event.id} 一键生成: ${event.reason || ''} · 待合规补充分析后报送`,
        createdAt: port.now(),
        submittedAt: null,
        closedAt: null,
      };
      reports.push(report);
      return ok({ report, note: `已生成 STR 草稿 ${report.refNo}, 可在列表中一键报送` });
    },

    submitStr(id) {
      const report = port.strReports().find(item => item.id === id);
      if (!report) return failure(404, 'STR 不存在');
      if (report.status !== 'draft') return failure(409, `仅草稿状态可报送, 当前: ${port.strStatusLabels[report.status]}`);
      report.status = 'submitted';
      report.submittedAt = port.now();
      return ok({ report, note: `${report.refNo} 已通过监管门户报送(模拟)` });
    },

    documents() {
      const list = port.userDocs().map(document => {
        const daysLeft = Math.ceil((document.expiry - port.now()) / 864e5);
        const tier = port.docTier(daysLeft);
        return { ...document, expiryDay: port.isoDay(document.expiry), daysLeft, tier: tier.key, tierLabel: tier.label };
      }).sort((a, b) => a.daysLeft - b.daysLeft);
      const count = key => list.filter(document => document.tier === key).length;
      return ok({
        list,
        summary: { total: list.length, expired: count('expired'), d7: count('d7'), d30: count('d30'), d90: count('d90'), ok: count('ok') },
        tiers: [{ key: 'd7', label: '7 天内', color: 'red' }, { key: 'd30', label: '30 天内', color: 'amber' }, { key: 'd90', label: '90 天内', color: 'amber' }],
      });
    },

    cases() {
      const cases = port.cases();
      const count = status => cases.filter(item => item.status === status).length;
      return ok({
        list: [...cases].sort((a, b) => b.createdAt - a.createdAt).map(presentCase),
        summary: { total: cases.length, open: count('open'), investigating: count('investigating'), closed: count('closed') },
      });
    },

    actOnCase(id, body = {}, actorId) {
      const item = port.cases().find(candidate => candidate.id === id);
      if (!item) return failure(404, '合规案件不存在');
      const action = String(body.action || '');
      const flow = { open: ['investigate', 'close'], investigating: ['close'], closed: ['reopen'] };
      if (!(flow[item.status] || []).includes(action)) return failure(409, `当前状态(${item.status})不允许该操作, 允许: ${(flow[item.status] || []).join(' / ') || '无'}`);
      const node = { investigate: '开始调查', close: '结案', reopen: '重新立案' };
      const defaultNote = { investigate: '调取关联 KYC/交易/筛查记录, 进入调查', close: '调查完毕, 结案归档', reopen: '有新线索, 重新立案调查' };
      item.status = action === 'investigate' ? 'investigating' : action === 'close' ? 'closed' : 'investigating';
      item.timeline.push({ ts: port.now(), node: node[action], note: String(body.note || '').trim() || defaultNote[action], operator: port.operatorName(actorId) });
      return ok({ case: presentCase(item) });
    },

    countries() {
      const rules = port.countryRules();
      const count = level => rules.filter(item => item.level === level).length;
      const rank = { prohibited: 0, restricted: 1, allowed: 2 };
      return ok({
        list: [...rules].sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3)),
        summary: { total: rules.length, prohibited: count('prohibited'), restricted: count('restricted'), allowed: count('allowed') },
        note: '政策清单仅作合规展示, 未接入交易链路(演示)',
      });
    },
  };
}
