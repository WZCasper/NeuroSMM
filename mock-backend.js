// Мок-backend на чистом Node.js (без Express/Prisma/БД) — НЕ замена реальному
// backend из /home/claude/neuro-backend. Единственная цель: проверить, что
// фронтенд (index.html) корректно формирует запросы и обрабатывает ответы
// согласно API-контракту, описанному в docs/02-api-design.md — в среде без
// доступа к PostgreSQL и npm install для реального Express-сервера.
//
// Реализует только то подмножество эндпоинтов, которое фронтенд сейчас
// реально вызывает: /auth/login, /auth/register, /bots (GET/POST/PATCH),
// /campaigns (GET/POST/PATCH).

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 3000;

// In-memory "база данных" — намеренно примитивная, только для проверки контракта.
const db = {
  users: [{ id: 'user-1', email: 'demo@agency.com', password: 'password123', name: 'Demo User' }],
  tenants: [{ id: 'tenant-1', name: 'Demo Agency', planId: 'vip' }],
  bots: [],
  campaigns: [],
  plans: [
    { id: 'start', name: 'Start', priceEur: 19, maxWorkerBots: 2, maxSupportBots: 1, maxMessagesPerMonth: 15000, isHighlighted: false,
      features: { ru: ['2 рабочих бота', '1 support-бот', '15 000 сообщений/мес'], en: ['2 worker bots', '1 support bot', '15,000 messages/mo'] } },
    { id: 'vip', name: 'VIP', priceEur: 49, maxWorkerBots: 5, maxSupportBots: 3, maxMessagesPerMonth: 60000, isHighlighted: true,
      features: { ru: ['5 рабочих ботов', '3 support-бота', '60 000 сообщений/мес'], en: ['5 worker bots', '3 support bots', '60,000 messages/mo'] } },
    { id: 'agency', name: 'Agency', priceEur: 149, maxWorkerBots: 5, maxSupportBots: 3, maxMessagesPerMonth: 250000, isHighlighted: false,
      features: { ru: ['5 рабочих ботов', '3 support-бота', '250 000 сообщений/мес'], en: ['5 worker bots', '3 support bots', '250,000 messages/mo'] } },
  ],
  invoices: [
    { id: 'inv-1', amountEur: 49, descriptionKey: 'subscription_renewal', descriptionParams: { planName: 'VIP' }, issuedAt: new Date(Date.now() - 86400000 * 15).toISOString() },
  ],
  teamMembers: [
    { id: 'member-1', role: 'owner', user: { id: 'user-1', name: 'Demo User', email: 'demo@agency.com' } },
    { id: 'member-2', role: 'manager', user: { id: 'user-2', name: 'Anna Sokolova', email: 'anna@agency.com' } },
  ],
  auditLog: [
    { id: 'audit-1', category: 'security', actionKey: 'bot.settings.updated', metadata: { rateLimitPerMin: 30 }, actorUser: { name: 'Demo User' }, createdAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'audit-2', category: 'team', actionKey: 'team.member.invited', metadata: { email: 'anna@agency.com', role: 'manager' }, actorUser: { name: 'Demo User' }, createdAt: new Date(Date.now() - 7200000).toISOString() },
  ],
};
let nextBotId = 1;
let nextCampaignId = 1;
let nextMemberId = 3;
let nextAuditId = 3;

function fakeToken(payload) {
  // Не настоящий JWT — просто base64 от JSON, достаточно для мок-проверки,
  // что фронт отправляет Authorization: Bearer <токен>, полученный от /auth/login.
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace('/api/v1', '');
  const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  console.log(`[mock-backend] ${req.method} ${path}`);

  // ── AUTH ──────────────────────────────────────────────────────────
  if (path === '/auth/login' && req.method === 'POST') {
    const user = db.users.find((u) => u.email === body.email && u.password === body.password);
    if (!user) return sendJson(res, 401, { error: 'invalid_credentials', message: 'Неверный email или пароль' });

    const tenant = db.tenants[0];
    return sendJson(res, 200, {
      accessToken: fakeToken({ sub: user.id, tenantId: tenant.id, role: 'owner' }),
      user: { id: user.id, email: user.email, name: user.name },
      tenants: [{ id: tenant.id, name: tenant.name, role: 'owner' }],
    });
  }

  if (path === '/auth/register' && req.method === 'POST') {
    const newUser = { id: `user-${db.users.length + 1}`, email: body.email, password: body.password, name: body.name };
    db.users.push(newUser);
    const newTenant = { id: `tenant-${db.tenants.length + 1}`, name: body.tenantName, plan: { maxWorkerBots: 5, maxSupportBots: 3 } };
    db.tenants.push(newTenant);

    return sendJson(res, 201, {
      accessToken: fakeToken({ sub: newUser.id, tenantId: newTenant.id, role: 'owner' }),
      user: { id: newUser.id, email: newUser.email, name: newUser.name },
      tenant: { id: newTenant.id, name: newTenant.name },
    });
  }

  // ── BOTS ──────────────────────────────────────────────────────────
  if (path === '/bots' && req.method === 'GET') {
    return sendJson(res, 200, { bots: db.bots });
  }

  if (path === '/bots' && req.method === 'POST') {
    const activeWorkerCount = db.bots.filter((b) => b.kind === 'worker').length;
    if (body.kind === 'worker' && activeWorkerCount >= 5) {
      return sendJson(res, 409, { error: 'bot_limit_exceeded', message: 'Лимит ботов исчерпан', kind: 'worker', limit: 5 });
    }
    const bot = {
      id: `bot-${nextBotId++}`, kind: body.kind, platform: body.platform, name: body.name,
      status: 'active', rateLimitPerMin: 30, dailyMessageLimit: 0, adaptiveThrottleEnabled: true,
      proxy: null, schedule: null, dailyStats: [],
    };
    db.bots.push(bot);
    return sendJson(res, 201, { bot });
  }

  const botStatusMatch = path.match(/^\/bots\/([^/]+)\/status$/);
  if (botStatusMatch && req.method === 'PATCH') {
    const bot = db.bots.find((b) => b.id === botStatusMatch[1]);
    if (!bot) return sendJson(res, 404, { error: 'not_found' });
    bot.status = body.status;
    return sendJson(res, 200, { bot });
  }

  const botSettingsMatch = path.match(/^\/bots\/([^/]+)\/settings$/);
  if (botSettingsMatch && req.method === 'PATCH') {
    const bot = db.bots.find((b) => b.id === botSettingsMatch[1]);
    if (!bot) return sendJson(res, 404, { error: 'not_found' });
    Object.assign(bot, {
      rateLimitPerMin: body.rateLimitPerMin ?? bot.rateLimitPerMin,
      dailyMessageLimit: body.dailyMessageLimit ?? bot.dailyMessageLimit,
      adaptiveThrottleEnabled: body.adaptiveThrottleEnabled ?? bot.adaptiveThrottleEnabled,
      proxy: body.proxyEnabled !== undefined ? { enabled: body.proxyEnabled, type: body.proxyType, host: body.proxyHost, username: body.proxyUser } : bot.proxy,
      schedule: body.scheduleEnabled !== undefined ? { enabled: body.scheduleEnabled, from: body.scheduleFrom, to: body.scheduleTo, days: body.scheduleDays } : bot.schedule,
    });
    const warnings = body.rateLimitPerMin > 60 ? [{ field: 'rateLimitPerMin', message: `Лимит ${body.rateLimitPerMin}/мин выше 60 повышает риск блокировки API` }] : [];
    return sendJson(res, 200, { bot, warnings });
  }

  const proxyTestMatch = path.match(/^\/bots\/([^/]+)\/test-proxy$/);
  if (proxyTestMatch && req.method === 'POST') {
    return sendJson(res, 200, { ok: true, latencyMs: 42 });
  }

  // ── CAMPAIGNS ─────────────────────────────────────────────────────
  if (path === '/campaigns' && req.method === 'GET') {
    return sendJson(res, 200, { campaigns: db.campaigns });
  }

  if (path === '/campaigns' && req.method === 'POST') {
    const campaign = {
      id: `campaign-${nextCampaignId++}`, name: body.name, status: 'draft', platforms: body.platforms,
      abTestEnabled: body.abTestEnabled, variantAText: body.variantAText, variantBText: body.variantBText,
      progressPct: 0, _count: { recipients: 0, followupSteps: (body.followupSteps || []).length },
    };
    db.campaigns.push(campaign);
    return sendJson(res, 201, { campaign });
  }

  const campaignStatusMatch = path.match(/^\/campaigns\/([^/]+)\/status$/);
  if (campaignStatusMatch && req.method === 'PATCH') {
    const campaign = db.campaigns.find((c) => c.id === campaignStatusMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: 'not_found' });
    if (body.status === 'running') {
      // Мок всегда отказывает в запуске без ботов — имитирует реальное правило backend.
      const hasActiveBot = db.bots.some((b) => b.kind === 'worker' && b.status === 'active');
      if (!hasActiveBot) {
        return sendJson(res, 409, { error: 'no_active_bots', message: 'Нет активных рабочих ботов для рассылки' });
      }
      return sendJson(res, 409, { error: 'no_eligible_contacts', message: 'Нет контактов с подтверждённым opt-in (мок не реализует contact lists)' });
    }
    campaign.status = body.status;
    return sendJson(res, 200, { campaign });
  }

  // ── BILLING ───────────────────────────────────────────────────────
  if (path === '/billing/plans' && req.method === 'GET') {
    return sendJson(res, 200, { plans: db.plans });
  }

  if (path === '/billing/usage' && req.method === 'GET') {
    const tenant = db.tenants[0];
    const plan = db.plans.find((p) => p.id === tenant.planId);
    const usage = {
      workerBots: db.bots.filter((b) => b.kind === 'worker').length,
      supportBots: db.bots.filter((b) => b.kind === 'support').length,
      messagesSent: 12400, // фиксированное демо-значение, реальный счётчик не реализован в моке
    };
    return sendJson(res, 200, { plan, usage });
  }

  if (path === '/billing/invoices' && req.method === 'GET') {
    return sendJson(res, 200, { invoices: db.invoices });
  }

  if (path === '/billing/change-plan' && req.method === 'POST') {
    const tenant = db.tenants[0];
    const oldPlan = db.plans.find((p) => p.id === tenant.planId);
    const newPlan = db.plans.find((p) => p.id === body.planId);
    if (!newPlan) return sendJson(res, 404, { error: 'plan_not_found' });

    const workerCount = db.bots.filter((b) => b.kind === 'worker').length;
    const supportCount = db.bots.filter((b) => b.kind === 'support').length;
    if (workerCount > newPlan.maxWorkerBots) {
      return sendJson(res, 409, { error: 'plan_downgrade_blocked', message: `Нельзя перейти на ${newPlan.name}: используется ${workerCount} рабочих ботов, лимит — ${newPlan.maxWorkerBots}`, reason: 'worker_bots' });
    }
    if (supportCount > newPlan.maxSupportBots) {
      return sendJson(res, 409, { error: 'plan_downgrade_blocked', message: `Нельзя перейти на ${newPlan.name}: используется ${supportCount} support-ботов, лимит — ${newPlan.maxSupportBots}`, reason: 'support_bots' });
    }

    tenant.planId = newPlan.id;
    const invoice = { id: `inv-${db.invoices.length + 1}`, amountEur: newPlan.priceEur, descriptionKey: 'plan_change', descriptionParams: { oldPlanName: oldPlan.name, newPlanName: newPlan.name }, issuedAt: new Date().toISOString() };
    db.invoices.unshift(invoice);
    db.auditLog.unshift({ id: `audit-${nextAuditId++}`, category: 'billing', actionKey: 'plan.changed', metadata: { oldPlanId: oldPlan.id, newPlanId: newPlan.id }, actorUser: { name: 'Demo User' }, createdAt: new Date().toISOString() });

    return sendJson(res, 200, { tenant: { ...tenant, plan: newPlan }, invoice });
  }

  // ── TEAM (RBAC) ───────────────────────────────────────────────────
  if (path === '/tenant/members' && req.method === 'GET') {
    return sendJson(res, 200, { members: db.teamMembers });
  }

  if (path === '/tenant/members/invite' && req.method === 'POST') {
    if (db.teamMembers.some((m) => m.user.email === body.email)) {
      return sendJson(res, 409, { error: 'already_member', message: `${body.email} уже состоит в команде` });
    }
    const member = { id: `member-${nextMemberId++}`, role: body.role, user: { id: `user-${nextMemberId}`, name: body.email.split('@')[0], email: body.email } };
    db.teamMembers.push(member);
    db.auditLog.unshift({ id: `audit-${nextAuditId++}`, category: 'team', actionKey: 'team.member.invited', metadata: { email: body.email, role: body.role }, actorUser: { name: 'Demo User' }, createdAt: new Date().toISOString() });
    return sendJson(res, 201, { membership: member });
  }

  const memberMatch = path.match(/^\/tenant\/members\/([^/]+)$/);
  if (memberMatch && req.method === 'PATCH') {
    const member = db.teamMembers.find((m) => m.id === memberMatch[1]);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    if (member.role === 'owner') return sendJson(res, 403, { error: 'cannot_modify_owner', message: 'Нельзя изменить роль владельца' });
    member.role = body.role;
    db.auditLog.unshift({ id: `audit-${nextAuditId++}`, category: 'team', actionKey: 'team.member.role_changed', metadata: { memberId: member.id, newRole: body.role }, actorUser: { name: 'Demo User' }, createdAt: new Date().toISOString() });
    return sendJson(res, 200, { membership: member });
  }

  if (memberMatch && req.method === 'DELETE') {
    const member = db.teamMembers.find((m) => m.id === memberMatch[1]);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    if (member.role === 'owner') return sendJson(res, 403, { error: 'cannot_modify_owner', message: 'Нельзя удалить владельца' });
    db.teamMembers = db.teamMembers.filter((m) => m.id !== member.id);
    db.auditLog.unshift({ id: `audit-${nextAuditId++}`, category: 'team', actionKey: 'team.member.removed', metadata: { memberId: member.id }, actorUser: { name: 'Demo User' }, createdAt: new Date().toISOString() });
    return sendJson(res, 204, {});
  }

  // ── AUDIT LOG ─────────────────────────────────────────────────────
  if (path === '/tenant/audit-log' && req.method === 'GET') {
    const category = url.searchParams.get('category');
    let entries = db.auditLog;
    if (category && category !== 'all') entries = entries.filter((e) => e.category === category);
    return sendJson(res, 200, { entries, pagination: { page: 1, pageSize: 20, total: entries.length, totalPages: 1 } });
  }

  return sendJson(res, 404, { error: 'not_found', message: `Мок не реализует ${req.method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[mock-backend] Слушает на http://localhost:${PORT}/api/v1`);
  console.log(`[mock-backend] Тестовый пользователь: demo@agency.com / password123`);
});
