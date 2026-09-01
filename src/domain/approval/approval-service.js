import { failure, ok } from '../../api/response.js';

export function createApprovalService(port) {
  const timeout = approval => approval.status === 'pending'
    && (port.now() - (approval.updatedAt || approval.createdAt)) > 48 * 36e5;

  const present = approval => {
    const current = approval.nodes.find(node => node.state === 'active') || null;
    const index = approval.nodes.indexOf(current);
    return {
      ...approval,
      statusLabel: port.statusLabels[approval.status] || approval.status,
      currentNode: current ? {
        name: current.name,
        mode: current.mode,
        approvers: current.approvers,
        approvedNames: current.acts.filter(action => action.verdict === 'approve').map(action => action.name),
        remaining: current.approvers.filter(name => !current.acts.some(action => action.verdict === 'approve' && action.name === name)),
      } : null,
      step: current ? index + 1 : approval.nodes.length + 1,
      steps: approval.nodes.length,
      flowLabel: approval.nodes
        .map(node => `${node.state === 'done' ? '✓ ' : node === current ? '▶ ' : ''}${node.name}(${node.mode})`)
        .join(' → ') + (approval.status === 'approved' ? ' → ✓ 执行' : ''),
      timeout: timeout(approval),
    };
  };

  return {
    list(query = {}, actorId) {
      const approvals = port.approvals();
      const flag = port.flags().find(item => item.key === 'approvalsFlag');
      const box = ['todo', 'mine', 'all'].includes(query.box) ? query.box : 'todo';
      const types = Object.keys(port.typeLabels).map(key => ({ key, label: port.typeLabels[key] }));
      if (flag && !flag.enabled) {
        return ok({
          disabled: true,
          flag: 'approvalsFlag',
          notice: '审批中心功能已通过 Feature Flag 下线(approvalsFlag=off), 业务数据保留, 可在「运维中心 → Feature Flag」恢复',
          box,
          types,
          summary: { todo: 0, mine: 0, approved: 0, rejected: 0, cancelled: 0, timeout: 0, total: approvals.length },
          list: [],
        });
      }

      let list = [...approvals];
      if (box === 'todo') list = list.filter(approval => approval.status === 'pending');
      if (box === 'mine') list = list.filter(approval => approval.applicantId === actorId);
      if (query.type) list = list.filter(approval => approval.type === query.type);
      list.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      const count = status => approvals.filter(approval => approval.status === status).length;
      return ok({
        box,
        summary: {
          todo: count('pending'),
          mine: approvals.filter(approval => approval.applicantId === actorId && approval.status === 'pending').length,
          approved: count('approved'),
          rejected: count('rejected'),
          cancelled: count('cancelled'),
          timeout: approvals.filter(timeout).length,
          total: approvals.length,
        },
        types,
        list: list.map(present),
      });
    },

    action(id, body = {}, actor) {
      actor = { ...actor, name: port.operatorName(actor.id) };
      const approval = port.approvals().find(item => item.id === id);
      if (!approval) return failure(404, '审批单不存在');
      if (approval.status !== 'pending') {
        return failure(400, `该审批单已${port.statusLabels[approval.status] || approval.status}, 不能再操作`);
      }

      const activeNode = approval.nodes.find(node => node.state === 'active');
      if (body.action === 'cancel') {
        if (approval.applicantId !== actor.id) return failure(403, '仅发起人可撤回审批单');
        approval.status = 'cancelled';
        approval.nodes.forEach(node => { if (node.state === 'active') node.state = 'waiting'; });
        approval.resultNote = `发起人撤回${body.reason ? `: ${String(body.reason).slice(0, 120)}` : ''} (业务数据未变动)`;
        approval.finishedAt = approval.updatedAt = port.now();
        return ok({ approval: present(approval) });
      }
      if (!activeNode) return failure(400, '该审批单没有待办节点');

      if (body.action === 'transfer') {
        const toName = String(body.toName || '').trim();
        if (!toName) return failure(400, '请填写转交给谁(审批人姓名)');
        activeNode.acts.push({
          name: actor.name,
          verdict: 'transfer',
          note: `转交给 ${toName}${body.reason ? ` · ${String(body.reason).slice(0, 120)}` : ''}`,
          ts: port.now(),
        });
        activeNode.approvers = [toName];
        approval.updatedAt = port.now();
        return ok({ approval: present(approval) });
      }

      if (body.action === 'reject') {
        const reason = String(body.reason || '').trim();
        if (!reason) return failure(400, '驳回必须填写原因');
        activeNode.acts.push({ name: actor.name, verdict: 'reject', note: reason.slice(0, 200), ts: port.now() });
        activeNode.state = 'done';
        approval.nodes.forEach(node => { if (node.state === 'active' || node.state === 'waiting') node.state = 'done'; });
        approval.status = 'rejected';
        approval.resultNote = `驳回于「${activeNode.name}」: ${reason.slice(0, 120)} (业务数据未变动)`;
        approval.finishedAt = approval.updatedAt = port.now();
        return ok({ approval: present(approval) });
      }

      if (body.action === 'approve') {
        const acting = body.as && activeNode.approvers.includes(String(body.as)) ? String(body.as) : actor.name;
        if (activeNode.acts.some(action => action.name === acting && action.verdict === 'approve')) {
          return failure(400, `${acting} 在本节点已审批通过, 不能重复审批`);
        }
        activeNode.acts.push({ name: acting, verdict: 'approve', note: String(body.reason || '').slice(0, 200), ts: port.now() });
        const approvedNames = activeNode.acts.filter(action => action.verdict === 'approve').map(action => action.name);
        const passed = activeNode.mode === '会签'
          ? activeNode.approvers.every(name => approvedNames.includes(name))
          : true;
        if (passed) {
          activeNode.state = 'done';
          const nextNode = approval.nodes.find(node => node.state === 'waiting');
          if (nextNode) {
            nextNode.state = 'active';
            approval.updatedAt = port.now();
            return ok({ approval: present(approval), advanced: true, nextNode: nextNode.name });
          }
          approval.status = 'approved';
          approval.finishedAt = approval.updatedAt = port.now();
          approval.resultNote = port.executeBusiness(approval);
        } else {
          approval.updatedAt = port.now();
        }
        return ok({ approval: present(approval), executed: approval.status === 'approved', bizNote: approval.resultNote || '' });
      }

      return failure(400, '无效动作, 支持 approve / reject / transfer / cancel');
    },
  };
}
