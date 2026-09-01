import { failure, ok } from '../../api/response.js';

const ENT_STATUS_LABEL = { active: '正常', frozen: '已冻结', pending: '待开户' };
const ENT_LEVEL_LABEL = { business: '商务版', enterprise: '旗舰版' };
const ENT_MEMBER_ROLE_LABEL = { admin: '企业管理员', finance: '财务人员', approver: '审批人', employee: '普通员工', cardholder: '持卡员工' };
const ENT_MEMBER_STATUS_LABEL = { active: '在职', suspended: '已停用' };
const ENT_APPROVAL_STATUS_LABEL = { pending: '待审批', approved: '已通过', rejected: '已驳回', auto: '免审入账' };
const ENT_BILL_STATUS_LABEL = { pending: '待支付', paid: '已支付' };
const KYB_STATUS_LABEL = { pending: '待审核', approved: '已通过', rejected: '已驳回', info_required: '需补充材料' };
const CARD_LEVEL_LABEL = { standard: 'Standard 标准卡', gold: 'Gold 金卡', platinum: 'Platinum 白金卡' };
const CARD_PRESET = {
  standard: { single: 500, daily: 1500, monthly: 20000 },
  gold: { single: 2000, daily: 6000, monthly: 80000 },
  platinum: { single: 10000, daily: 30000, monthly: 400000 },
};
const ORCH_SCENE_LABEL = { topup_fiat: '法币充值', topup_crypto: '加密充值' };
const BILL_FEE_RATE = 0.005;
const CONSUME_FEE_RATE = 0.015;

export function createEnterpriseService(port) {
  const round = value => port.round(value);
  const accounts = () => port.entAccounts();
  const members = () => port.entMembers();
  const departments = () => port.entDepts();
  const cards = () => port.entCards();
  const txApprovals = () => port.entTxApprovals();
  const bills = () => port.entBills();
  const departmentLogs = () => port.entDeptLogs();
  const byId = id => accounts().find(item => item.id === +id);
  const departmentById = id => departments().find(item => item.id === +id);
  const cardById = id => cards().find(item => item.id === +id);
  const membersOf = entId => members().filter(item => item.entId === +entId);
  const departmentsOf = entId => departments().filter(item => item.entId === +entId);
  const cardsOf = entId => cards().filter(item => item.entId === +entId);
  const remaining = department => round((department.monthlyBudget || 0) - (department.used || 0));
  const operatorName = actorId => port.operatorName(actorId) || '总监';
  const addTimeline = (ent, node, note, actorId, ts) => {
    ent.timeline.unshift({ ts: ts || port.now(), node, note, operator: operatorName(actorId) || '系统' });
  };

  const presentCard = card => {
    const ent = byId(card.entId) || {};
    const department = departmentById(card.deptId) || {};
    return {
      ...card,
      entName: ent.name || '—',
      deptName: department.name || '未分配',
      ccNo: department.ccNo || '—',
      holderName: card.holderName || (members().find(item => item.id === card.memberId) || {}).name || '—',
      levelLabel: CARD_LEVEL_LABEL[card.level] || ENT_LEVEL_LABEL[card.level] || card.level,
      statusLabel: card.status === 'active' ? '使用中' : card.status === 'frozen' ? '已冻结' : card.status,
    };
  };

  const presentApproval = approval => {
    const ent = byId(approval.entId) || {};
    const department = departmentById(approval.deptId) || {};
    const card = cardById(approval.cardId) || {};
    return {
      ...approval,
      entName: ent.name || '—',
      deptName: department.name || '—',
      cardNo: card.cardNo ? port.maskCardNo(card.cardNo) : '—',
      statusLabel: ENT_APPROVAL_STATUS_LABEL[approval.status] || approval.status,
    };
  };

  const presentBill = bill => {
    const ent = byId(bill.entId) || {};
    return {
      ...bill,
      entName: ent.name || '—',
      statusLabel: ENT_BILL_STATUS_LABEL[bill.status] || bill.status,
      invoiced: !!bill.invoiceNo,
      payable: round(bill.total != null ? bill.total : bill.serviceFee),
    };
  };

  const presentAccount = ent => {
    const kyb = ent.kybCaseId ? port.kybCases().find(item => item.id === ent.kybCaseId) : null;
    const entDepartments = departmentsOf(ent.id);
    return {
      ...ent,
      levelLabel: ENT_LEVEL_LABEL[ent.level] || ent.level,
      statusLabel: ENT_STATUS_LABEL[ent.status] || ent.status,
      kybCaseId: ent.kybCaseId,
      kybCompany: kyb ? kyb.company : '',
      kybStatus: kyb ? kyb.status : null,
      kybStatusLabel: kyb ? (KYB_STATUS_LABEL[kyb.status] || kyb.status) : '未提交',
      memberCount: membersOf(ent.id).length,
      deptCount: entDepartments.length,
      cardCount: cardsOf(ent.id).length,
      pendingApprovals: txApprovals().filter(item => item.entId === ent.id && item.status === 'pending').length,
      pendingBills: bills().filter(item => item.entId === ent.id && item.status === 'pending').length,
      deptBudgetTotal: round(entDepartments.reduce((sum, item) => sum + (item.monthlyBudget || 0), 0)),
      deptUsedTotal: round(entDepartments.reduce((sum, item) => sum + (item.used || 0), 0)),
    };
  };

  const postConsumption = approval => {
    const ent = byId(approval.entId);
    const department = departmentById(approval.deptId);
    const amount = round(approval.amount);
    const fee = round(amount * CONSUME_FEE_RATE);
    port.ensureEntLedgerAccount(ent);
    port.ensureMerchantLedgerAccount(approval.merchant);
    port.postLedgerTx(`ENTX${approval.id}`, `企业卡消费 · ${ent.name} · ${approval.memberName} @ ${approval.merchant}`, port.now(), [
      { key: `ent:${ent.id}`, dir: 'debit', amount, memo: `企业主账户扣款 · ${approval.memberName} · ${approval.merchant}` },
      { key: `merchant:${approval.merchant}`, dir: 'credit', amount: round(amount - fee), memo: '商户待结算净额(扣 1.5% 收单手续费)' },
      { key: 'fee', dir: 'credit', amount: fee, memo: `企业卡收单手续费 $${fee.toFixed(2)}` },
    ]);
    ent.balance = round(ent.balance - amount);
    if (department) department.used = round((department.used || 0) + amount);
    return fee;
  };

  return {
    listAccounts() {
      const list = accounts().map(presentAccount);
      const count = status => accounts().filter(item => item.status === status).length;
      return ok({
        list,
        summary: {
          total: accounts().length,
          active: count('active'),
          frozen: count('frozen'),
          pending: count('pending'),
          balanceTotal: round(accounts().reduce((sum, item) => sum + item.balance, 0)),
          creditTotal: round(accounts().reduce((sum, item) => sum + (item.creditLimit || 0), 0)),
          cards: cards().length,
          members: members().length,
          depts: departments().length,
          pendingApprovals: txApprovals().filter(item => item.status === 'pending').length,
          pendingBills: bills().filter(item => item.status === 'pending').length,
        },
        flow: ['企业充值', '分配部门预算', '员工消费', '部门审批', '企业结算'],
      });
    },

    account(id) {
      const ent = byId(id);
      if (!ent) return failure(404, '企业不存在');
      const ledgerAccount = port.ledgerAccounts().find(item => item.key === `ent:${ent.id}`);
      const entDepartmentIds = new Set(departmentsOf(ent.id).map(item => item.id));
      return ok({
        ent: presentAccount(ent),
        members: membersOf(ent.id).map(member => ({
          ...member,
          roleLabel: ENT_MEMBER_ROLE_LABEL[member.role] || member.role,
          statusLabel: ENT_MEMBER_STATUS_LABEL[member.status] || member.status,
          cards: cards().filter(card => card.memberId === member.id).length,
        })),
        depts: departmentsOf(ent.id).map(department => ({
          ...department,
          remaining: remaining(department),
          usage: department.monthlyBudget ? +(100 * (department.used || 0) / department.monthlyBudget).toFixed(1) : 0,
          cardCount: cards().filter(card => card.deptId === department.id).length,
        })),
        cards: cardsOf(ent.id).map(presentCard),
        approvals: txApprovals().filter(item => item.entId === ent.id).slice(0, 30).map(presentApproval),
        bills: bills().filter(item => item.entId === ent.id).map(presentBill),
        budgetLogs: departmentLogs().filter(item => entDepartmentIds.has(item.deptId)),
        ledger: ledgerAccount ? {
          key: ledgerAccount.key,
          balance: ledgerAccount.balance,
          typeLabel: port.ledgerTypeLabels[ledgerAccount.type] || ledgerAccount.type,
        } : null,
      });
    },

    topup(body = {}, actorId) {
      const ent = byId(body.entId);
      if (!ent) return failure(404, '企业不存在');
      if (ent.status !== 'active') return failure(409, `企业状态「${ENT_STATUS_LABEL[ent.status] || ent.status}」不可充值`);
      const amount = round(+body.amount);
      if (!(amount > 0)) return failure(400, '请填写正确的充值金额');
      const payWay = body.method === 'usdt' ? 'usdt' : 'fiat';
      const scene = payWay === 'usdt' ? 'topup_crypto' : 'topup_fiat';
      const route = port.routeFor(scene, 'USD');
      if (!route.adapter) return failure(409, `渠道路由失败: ${route.reason}`);
      port.ensureEntLedgerAccount(ent);
      const channelKey = payWay === 'usdt' ? 'channel:usdt' : 'channel:fiat';
      port.ensureLedgerAccount(channelKey, 'channel', payWay === 'usdt' ? '渠道 · 加密网关' : '渠道 · 法币网关');
      port.postLedgerTx(`ENTT${port.nid()}`, `企业充值 · ${ent.name}`, port.now(), [
        { key: channelKey, dir: 'debit', amount, memo: `企业对公渠道收款 · 路由 ${route.adapter.name}` },
        { key: `ent:${ent.id}`, dir: 'credit', amount, memo: `充值入企业主账户(${payWay === 'usdt' ? 'USDT' : '法币'})` },
      ]);
      ent.balance = round(ent.balance + amount);
      addTimeline(ent, '企业充值', `$${amount.toFixed(2)} 经 ${route.adapter.name}(${payWay === 'usdt' ? '加密网关' : '法币网关'}) 入企业主账户 · 路由决策: ${route.reason}`, actorId);
      return ok({
        ok: true,
        ent: presentAccount(ent),
        balance: ent.balance,
        route: {
          adapter: route.adapter.name,
          scene: ORCH_SCENE_LABEL[scene] || scene,
          reason: route.reason,
          backup: route.backup ? route.backup.name : '无',
        },
        note: `复式分录: 借 ${channelKey} / 贷 ent:${ent.id}`,
      });
    },

    adjustDepartmentBudget(id, body = {}, actorId) {
      const department = departmentById(id);
      if (!department) return failure(404, '部门不存在');
      const delta = round(+body.delta);
      if (!delta) return failure(400, '调整幅度不能为 0');
      const from = round(department.monthlyBudget);
      const to = round(from + delta);
      if (to < 0) return failure(400, `调整后预算不能为负(当前 $${from.toFixed(2)}, 已用 $${(department.used || 0).toFixed(2)})`);
      department.monthlyBudget = to;
      const log = {
        id: port.nid(),
        deptId: department.id,
        from,
        to,
        delta,
        note: String(body.note || '').trim() || (delta > 0 ? '预算追加' : '预算削减'),
        by: operatorName(actorId),
        at: port.now(),
      };
      departmentLogs().unshift(log);
      addTimeline(byId(department.entId), '部门预算调整', `${department.name}(${department.ccNo}) $${from.toFixed(2)} → $${to.toFixed(2)}${log.note ? ` · ${log.note}` : ''}`, actorId);
      return ok({
        ok: true,
        dept: { ...department, remaining: remaining(department), usage: to ? +(100 * (department.used || 0) / to).toFixed(1) : 0 },
        log,
        note: `变更已记入预算调整历史(变更前 $${from.toFixed(2)} → 变更后 $${to.toFixed(2)})`,
      });
    },

    issueCards(body = {}, actorId) {
      const ent = byId(body.entId);
      if (!ent) return failure(404, '企业不存在');
      if (ent.status !== 'active') return failure(409, `企业状态「${ENT_STATUS_LABEL[ent.status] || ent.status}」不可发卡`);
      const department = departmentById(body.deptId);
      if (!department || department.entId !== ent.id) return failure(404, '部门不存在或不属于该企业');
      const count = Math.min(20, Math.max(1, +body.count || 1));
      const level = CARD_PRESET[body.level] ? body.level : 'standard';
      const activeMembers = membersOf(ent.id).filter(item => item.status === 'active');
      if (!activeMembers.length) return failure(409, '该企业没有在职成员可持卡');
      const newCards = [];
      for (let index = 0; index < count; index += 1) {
        const member = activeMembers[(cardsOf(ent.id).length + index) % activeMembers.length];
        const card = {
          id: port.nid(),
          entId: ent.id,
          memberId: member.id,
          holderName: member.name,
          deptId: department.id,
          cardNo: `5311 ${port.randomInt(1000, 9999)} ${port.randomInt(1000, 9999)} ${port.randomInt(1000, 9999)}`,
          level,
          limits: { ...CARD_PRESET[level] },
          status: 'active',
          issuedAt: port.now(),
        };
        cards().push(card);
        newCards.push(card);
      }
      const admin = activeMembers.find(item => item.role === 'admin') || activeMembers[0];
      const approvalNo = port.nid();
      port.workflowApprovals().unshift({
        id: approvalNo,
        type: 'ent_card_issue',
        typeLabel: '企业批量发卡',
        title: `${ent.name} 批量发卡 ×${count}(${CARD_LEVEL_LABEL[level] || level})`,
        bizRef: `企业服务模块已直接发 ${count} 张企业卡(部门: ${department.name} · 成本中心 ${department.ccNo}), 本单为审批中心备案归档, 不阻塞发卡`,
        amount: null,
        payload: { entId: ent.id, deptId: department.id, count, level, cardIds: newCards.map(card => card.id) },
        applicant: operatorName(actorId),
        applicantId: actorId,
        applyNote: `批量发卡备案: 卡段 5311* · 成本中心 ${department.ccNo}`,
        status: 'pending',
        nodes: [{ key: '企业管理员确认', name: '企业管理员确认', mode: '或签', approvers: [admin.name], state: 'active', acts: [] }],
        createdAt: port.now(),
        updatedAt: port.now(),
        finishedAt: null,
        resultNote: '',
      });
      addTimeline(ent, '批量发卡', `${department.name}(${department.ccNo})新发 ${count} 张企业卡(${level}), 已生成审批中心备案单 #${approvalNo}`, actorId);
      return ok({
        ok: true,
        cards: newCards.map(presentCard),
        count: newCards.length,
        approvalNo,
        note: `已发 ${count} 张企业卡(卡段 5311*), 并生成审批中心「企业批量发卡」备案单(不阻塞, 可在审批中心归档)`,
      });
    },

    updateCardLimits(body = {}, actorId) {
      const card = cardById(body.cardId);
      if (!card) return failure(404, '企业卡不存在');
      const single = round(+body.single);
      const daily = round(+body.daily);
      const monthly = round(+body.monthly);
      if (!(single > 0 && daily > 0 && monthly > 0)) return failure(400, '单笔 / 日 / 月限额必须大于 0');
      if (single > daily || daily > monthly) return failure(400, '限额需满足: 单笔 ≤ 日 ≤ 月');
      const from = { ...card.limits };
      card.limits = { single, daily, monthly };
      addTimeline(byId(card.entId), '卡限额调整', `${card.holderName || '员工卡'} ${port.maskCardNo(card.cardNo)} 单笔 $${from.single.toFixed(2)}→$${single.toFixed(2)} / 日 $${from.daily.toFixed(2)}→$${daily.toFixed(2)} / 月 $${from.monthly.toFixed(2)}→$${monthly.toFixed(2)}`, actorId);
      return ok({ ok: true, card: presentCard(card), from, note: '限额已更新(次日生效口径, 演示即时生效)' });
    },

    consume(body = {}) {
      const ent = byId(body.entId);
      if (!ent) return failure(404, '企业不存在');
      const card = cardById(body.cardId);
      if (!card || card.entId !== ent.id) return failure(404, '企业卡不存在或不属于该企业');
      if (ent.status !== 'active') return failure(409, `企业状态「${ENT_STATUS_LABEL[ent.status] || ent.status}」不可消费`);
      if (card.status !== 'active') return failure(409, '该卡已冻结/停用, 不可消费');
      const amount = round(+body.amount);
      if (!(amount > 0)) return failure(400, '请填写正确的消费金额');
      if (amount > ent.balance) return failure(409, `企业主账户余额不足($${ent.balance.toFixed(2)}), 请先充值`);
      const merchant = String(body.merchant || '').trim() || '企业采购';
      const department = departmentById(card.deptId);
      const reasons = [];
      if (amount > (card.limits || {}).single) reasons.push(`超卡单笔限额 $${round(card.limits.single).toFixed(2)}`);
      if (department && amount > remaining(department)) reasons.push(`超部门剩余预算 $${remaining(department).toFixed(2)}`);
      const approval = {
        id: port.nid(),
        entId: ent.id,
        cardId: card.id,
        memberId: card.memberId,
        memberName: card.holderName || '—',
        deptId: card.deptId,
        merchant,
        amount,
        note: String(body.note || '员工企业卡消费').slice(0, 200),
        trigger: reasons.join(' 且 '),
        status: reasons.length ? 'pending' : 'auto',
        createdAt: port.now(),
        actedAt: reasons.length ? null : port.now(),
        actedBy: '',
        actNote: reasons.length ? '' : '额度与预算内, 免审直接入账',
      };
      txApprovals().unshift(approval);
      if (reasons.length) return ok({ needApproval: true, approval: presentApproval(approval), note: `触发审批(${approval.trigger}), 已生成待审批单 → 企业服务 · 消费审批 处理` });
      postConsumption(approval);
      return ok({
        ok: true,
        auto: true,
        approval: presentApproval(approval),
        balance: ent.balance,
        deptUsed: department ? department.used : null,
        note: '额度与预算内免审入账: 借企业主账户 / 贷商户净额 / 贷手续费(1.5%), 并已扣减部门预算',
      });
    },

    listApprovals(query = {}) {
      let list = txApprovals().map(presentApproval);
      if (query.status) list = list.filter(item => item.status === query.status);
      const count = status => txApprovals().filter(item => item.status === status).length;
      return ok({
        list: list.sort((left, right) => right.createdAt - left.createdAt),
        summary: {
          total: txApprovals().length,
          pending: count('pending'),
          approved: count('approved') + count('auto'),
          rejected: count('rejected'),
          pendingAmount: round(txApprovals().filter(item => item.status === 'pending').reduce((sum, item) => sum + item.amount, 0)),
        },
        rule: '超部门剩余预算 或 超卡单笔限额的消费需审批人批准; 通过 → 复式记账+扣部门预算, 驳回 → 不记账不动预算',
      });
    },

    actOnApproval(id, body = {}, actorId) {
      const approval = txApprovals().find(item => item.id === +id);
      if (!approval) return failure(404, '审批单不存在');
      if (approval.status !== 'pending') return failure(409, `仅待审批单可操作, 当前状态: ${ENT_APPROVAL_STATUS_LABEL[approval.status] || approval.status}`);
      const action = String(body.action || '');
      const note = String(body.note || '').trim();
      const ent = byId(approval.entId);
      const approver = (membersOf(approval.entId).find(item => item.role === 'approver') || {}).name || operatorName(actorId) || '审批人';
      if (action === 'approve') {
        if (approval.amount > ent.balance) return failure(409, `企业主账户余额不足($${ent.balance.toFixed(2)}), 无法入账`);
        const fee = postConsumption(approval);
        approval.status = 'approved';
        approval.actedAt = port.now();
        approval.actedBy = approver;
        approval.actNote = note || '审批人批准, 已入账';
        addTimeline(ent, '消费审批通过', `${approval.memberName} @ ${approval.merchant} $${round(approval.amount).toFixed(2)} 已入账(手续费 $${fee.toFixed(2)}), 部门预算已扣减`, actorId);
        return ok({
          ok: true,
          approval: presentApproval(approval),
          entBalance: ent.balance,
          ledgerTxId: `ENTX${approval.id}`,
          fee,
          note: `已复式记账(借 ent:${ent.id} / 贷 merchant:${approval.merchant} / 贷 fee)并扣减部门预算`,
        });
      }
      if (action === 'reject') {
        if (!note) return failure(400, '驳回必须填写原因');
        approval.status = 'rejected';
        approval.actedAt = port.now();
        approval.actedBy = approver;
        approval.actNote = note;
        addTimeline(ent, '消费审批驳回', `${approval.memberName} @ ${approval.merchant} $${round(approval.amount).toFixed(2)} · ${note}(未记账, 未扣预算)`, actorId);
        return ok({ ok: true, approval: presentApproval(approval), note: '已驳回: 未记账、未扣部门预算' });
      }
      return failure(400, `未知 action: ${action}`);
    },

    listBills(query = {}) {
      let list = bills().map(presentBill);
      if (query.status) list = list.filter(item => item.status === query.status);
      const count = status => bills().filter(item => item.status === status).length;
      return ok({
        list: list.sort((left, right) => right.period < left.period ? -1 : 1),
        summary: {
          total: bills().length,
          pending: count('pending'),
          paid: count('paid'),
          pendingTotal: round(bills().filter(item => item.status === 'pending').reduce((sum, item) => sum + (item.total != null ? item.total : item.serviceFee), 0)),
        },
        rule: `月度账单 = 当月已入账消费汇总 + ${(BILL_FEE_RATE * 100).toFixed(1)}% 账单服务费; 开票生成发票号, 支付从企业主账户扣服务费(借 ent / 贷 fee)`,
      });
    },

    invoiceBill(id, actorId) {
      const bill = bills().find(item => item.id === +id);
      if (!bill) return failure(404, '账单不存在');
      if (bill.invoiceNo) return failure(409, `该账单已开票: ${bill.invoiceNo}`);
      bill.invoiceNo = `INV-${bill.period.replace('-', '')}-${port.randomInt(10000, 99999)}`;
      bill.invoicedAt = port.now();
      addTimeline(byId(bill.entId), '账单开票', `${bill.period} 月度账单 $${round(bill.total != null ? bill.total : bill.serviceFee).toFixed(2)} → 发票号 ${bill.invoiceNo}`, actorId);
      return ok({ ok: true, bill: presentBill(bill), note: '发票号已生成(电子发票, 演示)' });
    },

    payBill(id, actorId) {
      const bill = bills().find(item => item.id === +id);
      if (!bill) return failure(404, '账单不存在');
      if (bill.status === 'paid') return failure(409, `该账单已支付(${port.isoDay(bill.paidAt)})`);
      const ent = byId(bill.entId);
      const payable = round(bill.total != null ? bill.total : bill.serviceFee);
      if (payable > ent.balance) return failure(409, `企业主账户余额不足($${ent.balance.toFixed(2)}), 需 $${payable.toFixed(2)}, 请先充值`);
      port.ensureEntLedgerAccount(ent);
      port.postLedgerTx(`ENTB${bill.id}-${port.nid()}`, `企业账单支付 · ${ent.name} · ${bill.period}`, port.now(), [
        { key: `ent:${ent.id}`, dir: 'debit', amount: payable, memo: `${bill.period} 账单服务费 0.5%(消费款已在发生时实时入账)` },
        { key: 'fee', dir: 'credit', amount: payable, memo: `账单服务费收入 · 账单 #${bill.id}` },
      ]);
      ent.balance = round(ent.balance - payable);
      bill.status = 'paid';
      bill.paidAt = port.now();
      bill.paidBy = operatorName(actorId);
      if (!bill.invoiceNo) {
        bill.invoiceNo = `INV-${bill.period.replace('-', '')}-${port.randomInt(10000, 99999)}`;
        bill.invoicedAt = port.now();
      }
      addTimeline(ent, '账单支付', `${bill.period} 账单已支付 $${payable.toFixed(2)}(服务费) · 发票 ${bill.invoiceNo}`, actorId);
      return ok({
        ok: true,
        bill: presentBill(bill),
        entBalance: ent.balance,
        note: `已支付并记账(借 ent:${ent.id} / 贷 fee), 消费本金已在发生时实时入账不重复扣款`,
      });
    },

    report() {
      const list = departments().map(department => {
        const ent = byId(department.entId);
        const departmentCards = cards().filter(card => card.deptId === department.id);
        const approvals = txApprovals().filter(approval => approval.deptId === department.id);
        const used = round(department.used || 0);
        return {
          deptId: department.id,
          entId: department.entId,
          entName: ent ? ent.name : '—',
          deptName: department.name,
          ccNo: department.ccNo,
          owner: department.owner,
          budget: round(department.monthlyBudget),
          used,
          remaining: remaining(department),
          usage: department.monthlyBudget ? +(100 * used / department.monthlyBudget).toFixed(1) : 0,
          cardCount: departmentCards.length,
          avgPerCard: departmentCards.length ? round(used / departmentCards.length) : 0,
          approvedCount: approvals.filter(item => item.status === 'approved' || item.status === 'auto').length,
          pendingCount: approvals.filter(item => item.status === 'pending').length,
          rejectedCount: approvals.filter(item => item.status === 'rejected').length,
        };
      }).sort((left, right) => right.usage - left.usage);
      return ok({
        list,
        summary: {
          depts: list.length,
          budgetTotal: round(list.reduce((sum, item) => sum + item.budget, 0)),
          usedTotal: round(list.reduce((sum, item) => sum + item.used, 0)),
          cards: cards().length,
          avgUsage: list.length ? +(list.reduce((sum, item) => sum + item.usage, 0) / list.length).toFixed(1) : 0,
        },
        note: '按部门月度预算使用率排行, 可定位超支风险部门',
      });
    },
  };
}
