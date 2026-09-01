import { failure, ok } from '../../api/response.js';

export function createTenantService({ all, findById, present, statusLabels }) {
  return {
    list() {
      const tenants = all();
      const count = (status) => tenants.filter(t => t.status === status).length;
      return ok({
        list: tenants.map(present),
        summary: {
          total: tenants.length,
          active: count('active'), trial: count('trial'), pending: count('pending'), frozen: count('frozen'),
          gmv: +tenants.reduce((sum, tenant) => sum + tenant.isolation.gmv, 0).toFixed(2),
          users: tenants.reduce((sum, tenant) => sum + tenant.isolation.users, 0),
        },
      });
    },

    update(id, body = {}) {
      const tenant = findById(id);
      if (!tenant) return failure(404, '租户不存在');
      if (body.status) {
        if (!statusLabels[body.status]) return failure(400, `无效的租户状态: ${body.status}`);
        if (tenant.isMain && body.status !== 'active') return failure(400, '主租户不可冻结或变更状态');
        tenant.status = body.status;
      }
      for (const key of ['domain', 'currency', 'locale', 'timezone', 'brandColor']) {
        if (body[key] != null) tenant[key] = String(body[key]).slice(0, 120);
      }
      if (body.commission) {
        for (const key of ['topup', 'consume', 'card']) {
          const values = body.commission[key];
          if (Array.isArray(values) && values.length === 3) tenant.commission[key] = values.map(value => Math.max(0, +value || 0));
        }
      }
      return ok({ tenant: present(tenant) });
    },
  };
}
