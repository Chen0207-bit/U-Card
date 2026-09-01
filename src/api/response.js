export const ok = (json, status = 200) => ({ status, json });

export const failure = (status, error, code, extra = {}) => ({
  status,
  json: { error, ...(code ? { code } : {}), ...extra },
});
