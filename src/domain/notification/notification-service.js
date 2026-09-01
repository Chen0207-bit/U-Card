import { failure, ok } from '../../api/response.js';

export function createNotificationService({ templates, sends, channels, now, randomInt }) {
  const channelName = key => channels().find(channel => channel.key === key)?.name || key;
  return {
    listTemplates() {
      return ok({ list: templates().map(template => ({ ...template, channelName: channelName(template.channel) })), channels: channels().map(channel => ({ key: channel.key, name: channel.name })) });
    },
    updateTemplate(id, body = {}) {
      const template = templates().find(item => item.id === id);
      if (!template) return failure(404, '模板不存在');
      if (typeof body.enabled === 'boolean') { template.enabled = body.enabled; template.updatedAt = now(); }
      return ok({ template: { ...template } });
    },
    listSends() {
      const all = sends();
      const list = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(send => ({ ...send, channelName: channelName(send.channel) }));
      const count = status => all.filter(send => send.status === status).length;
      const success = count('success');
      return ok({ list, summary: { total: all.length, success, failed: count('failed'), retrying: count('retrying'), rate: all.length ? Math.round(success / all.length * 1000) / 10 : 0 } });
    },
    retrySend(id) {
      const send = sends().find(item => item.id === id);
      if (!send) return failure(404, '发送记录不存在');
      if (!['failed', 'retrying'].includes(send.status)) return failure(400, '仅失败/重试中的记录可重发');
      send.status = 'success'; send.attempts = (send.attempts || 1) + 1; send.ms = randomInt(60, 900); send.retriedAt = now();
      return ok({ ok: true, send: { ...send, channelName: channelName(send.channel) } });
    },
    listChannels() {
      return ok({ list: channels().map(channel => ({ ...channel, sends: sends().filter(send => send.channel === channel.key).length })) });
    },
    updateChannel(key, body = {}) {
      const channel = channels().find(item => item.key === key);
      if (!channel) return failure(404, `渠道不存在: ${key}`);
      if (typeof body.enabled === 'boolean') channel.enabled = body.enabled;
      if (body.config && typeof body.config === 'object') for (const name of Object.keys(body.config)) channel.config[name] = String(body.config[name]).slice(0, 160);
      return ok({ channel: { ...channel } });
    },
  };
}
