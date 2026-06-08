const auditLog = require('../services/audit-log');

function audit(action, targetType) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        auditLog.log({
          userId: req.user?.id,
          userEmail: req.user?.email,
          action,
          targetType,
          targetId: req.params.id || req.body?.ma_doc || req.body?.ma_nv || '',
          detail: { method: req.method, path: req.originalUrl, statusCode: res.statusCode },
          ip: req.ip,
          userAgent: req.get('user-agent') || '',
        });
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = { audit };
