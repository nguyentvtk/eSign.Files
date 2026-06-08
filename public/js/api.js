const API = (() => {
  'use strict';
  const BASE = '/api';

  function _getToken() {
    return localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token') || '';
  }

  function _setAuth(data, remember) {
    const store = remember ? localStorage : sessionStorage;
    store.setItem('esign_token', data.token);
    store.setItem('esign_refresh', data.refreshToken);
    store.setItem('esign_user', JSON.stringify(data.user));
    store.setItem('esign_expires', data.expiresAt);
  }

  function _clearAuth() {
    ['esign_token', 'esign_refresh', 'esign_user', 'esign_expires'].forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });
  }

  function getUser() {
    const raw = localStorage.getItem('esign_user') || sessionStorage.getItem('esign_user');
    return raw ? JSON.parse(raw) : null;
  }

  function isLoggedIn() {
    return !!_getToken();
  }

  async function _fetch(path, opts = {}) {
    const token = _getToken();
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(BASE + path, { ...opts, headers });

    if (resp.status === 401) {
      const refreshed = await _tryRefresh();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${_getToken()}`;
        const retry = await fetch(BASE + path, { ...opts, headers });
        return retry.json();
      }
      _clearAuth();
      throw new Error('Session expired');
    }

    return resp.json();
  }

  async function _tryRefresh() {
    const refreshToken = localStorage.getItem('esign_refresh') || sessionStorage.getItem('esign_refresh');
    if (!refreshToken) return false;
    try {
      const resp = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data.success) {
        const store = localStorage.getItem('esign_token') ? localStorage : sessionStorage;
        store.setItem('esign_token', data.token);
        store.setItem('esign_refresh', data.refreshToken);
        store.setItem('esign_expires', data.expiresAt);
        return true;
      }
      return false;
    } catch { return false; }
  }

  const auth = {
    async login(email, password, remember = false) {
      const resp = await fetch(BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await resp.json();
      if (data.success) _setAuth(data, remember);
      return data;
    },
    async logout() {
      try { await _fetch('/auth/logout', { method: 'POST' }); } catch {}
      _clearAuth();
    },
    async me() { return _fetch('/auth/me'); },
    async setupOtp() { return _fetch('/auth/otp/setup', { method: 'POST' }); },
    async verifyOtp(token) { return _fetch('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ token }) }); },
    async validateOtp(token) { return _fetch('/auth/otp/validate', { method: 'POST', body: JSON.stringify({ token }) }); },
  };

  const users = {
    async list() { return _fetch('/users'); },
    async get(id) { return _fetch(`/users/${id}`); },
    async create(data) { return _fetch('/users', { method: 'POST', body: JSON.stringify(data) }); },
    async update(id, data) { return _fetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
    async remove(id) { return _fetch(`/users/${id}`, { method: 'DELETE' }); },
  };

  const documents = {
    async list(params = {}) {
      const qs = new URLSearchParams(params).toString();
      return _fetch(`/documents?${qs}`);
    },
    async get(id) { return _fetch(`/documents/${id}`); },
    async pending() { return _fetch('/documents/pending'); },
    async create(formData) {
      const token = _getToken();
      const resp = await fetch(BASE + '/documents', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      return resp.json();
    },
    async verify(id) { return _fetch(`/documents/${id}/verify`); },
    downloadUrl(id) { return `${BASE}/documents/${id}/download`; },
  };

  const signing = {
    async sign(data) { return _fetch('/signing/sign', { method: 'POST', body: JSON.stringify(data) }); },
    async reject(data) { return _fetch('/signing/reject', { method: 'POST', body: JSON.stringify(data) }); },
    async methods() { return _fetch('/signing/methods'); },
  };

  const audit = {
    async list(params = {}) {
      const qs = new URLSearchParams(params).toString();
      return _fetch(`/audit?${qs}`);
    },
    async actions() { return _fetch('/audit/actions'); },
    exportUrl(params = {}) {
      const qs = new URLSearchParams({ ...params, format: 'csv' }).toString();
      return `${BASE}/audit/export?${qs}`;
    },
  };

  const permissions = {
    async get() { return _fetch('/permissions'); },
    async update(data) { return _fetch('/permissions', { method: 'PUT', body: JSON.stringify({ permissions: data }) }); },
  };

  return { auth, users, documents, signing, audit, permissions, getUser, isLoggedIn, _clearAuth };
})();
