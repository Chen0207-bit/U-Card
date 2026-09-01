import { ok } from '../../api/response.js';

const TYPE_ORDER = ['channel', 'card', 'merchant', 'income', 'expense'];

export function createLedgerService(port) {
  const round = value => port.round(value);
  const frozenOf = key => round(port.frozenBalances().filter(item => item.accountKey === key && item.status === 'frozen').reduce((sum, item) => sum + item.amount, 0));

  const aggregateRow = (day, balances, accountsByKey) => {
    const row = { day, channel: 0, card: 0, merchant: 0, income: 0, expense: 0 };
    balances.forEach((balance, key) => {
      const account = accountsByKey.get(key);
      if (account) row[account.type] = round(row[account.type] + balance);
    });
    row.total = round(row.channel + row.card + row.merchant + row.income + row.expense);
    return row;
  };

  return {
    accounts() {
      const accounts = port.ledgerAccounts();
      const entries = port.ledgerEntries();
      const list = accounts.map(account => {
        const accountEntries = entries.filter(entry => entry.accountKey === account.key);
        return {
          key: account.key,
          type: account.type,
          typeLabel: port.typeLabels[account.type] || account.type,
          name: account.name,
          balance: account.balance,
          frozen: frozenOf(account.key),
          entryCount: accountEntries.length,
          recentCount: accountEntries.filter(entry => entry.createdAt >= port.now() - 7 * 864e5).length,
          lastEntryAt: accountEntries.length ? Math.max(...accountEntries.map(entry => entry.createdAt)) : null,
        };
      }).sort((a, b) => (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (b.balance - a.balance));
      const byType = {};
      accounts.forEach(account => { byType[account.type] = round((byType[account.type] || 0) + account.balance); });
      return ok({
        list,
        summary: {
          accounts: accounts.length,
          entries: entries.length,
          byType,
          frozenTotal: round(port.frozenBalances().filter(item => item.status === 'frozen').reduce((sum, item) => sum + item.amount, 0)),
        },
      });
    },

    entries(query = {}) {
      const days = parseInt(query.days, 10) || 0;
      const since = days > 0 ? port.now() - days * 864e5 : 0;
      const accountsByKey = new Map(port.ledgerAccounts().map(account => [account.key, account]));
      const list = port.ledgerEntries()
        .filter(entry => {
          const account = accountsByKey.get(entry.accountKey);
          return (!query.account || entry.accountKey === query.account)
            && (!query.type || (account && account.type === query.type))
            && entry.createdAt >= since;
        })
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .slice(0, 500)
        .map(entry => {
          const account = accountsByKey.get(entry.accountKey);
          return {
            ...entry,
            accountName: account ? account.name : entry.accountKey,
            accountType: account ? account.type : '',
            typeLabel: account ? (port.typeLabels[account.type] || account.type) : '',
          };
        });
      return ok({
        list,
        summary: {
          count: list.length,
          debitTotal: round(list.filter(entry => entry.dir === 'debit').reduce((sum, entry) => sum + entry.amount, 0)),
          creditTotal: round(list.filter(entry => entry.dir === 'credit').reduce((sum, entry) => sum + entry.amount, 0)),
          filters: { account: query.account || '', type: query.type || '', days: days || 'all' },
        },
      });
    },

    snapshots() {
      const accounts = port.ledgerAccounts();
      const snapshots = port.balanceSnapshots();
      const frozenBalances = port.frozenBalances();
      const accountsByKey = new Map(accounts.map(account => [account.key, account]));
      const days = [...new Set(snapshots.map(snapshot => snapshot.day))].sort();
      const rows = days.map(day => {
        const balances = new Map();
        snapshots.filter(snapshot => snapshot.day === day).forEach(snapshot => balances.set(snapshot.accountKey, snapshot.balance));
        return aggregateRow(day, balances, accountsByKey);
      });
      const today = port.isoDay(port.now());
      const current = aggregateRow(today, new Map(accounts.map(account => [account.key, account.balance])), accountsByKey);
      const todayIndex = rows.findIndex(row => row.day === current.day);
      if (todayIndex >= 0) rows[todayIndex] = current;
      else rows.push(current);
      return ok({
        rows,
        current,
        frozen: frozenBalances.map(item => ({ ...item, accountName: (accountsByKey.get(item.accountKey) || {}).name || item.accountKey })),
        frozenTotal: round(frozenBalances.filter(item => item.status === 'frozen').reduce((sum, item) => sum + item.amount, 0)),
        detailToday: snapshots.filter(snapshot => snapshot.day === today),
      });
    },

    verify: () => ok(port.verifyLedger()),
  };
}
