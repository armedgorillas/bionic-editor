import React, { useEffect, useState } from 'react';
import {
  FlaskConical,
  FolderGit2,
  BookOpen,
  ShieldCheck,
  Plus,
  Play,
  Snowflake,
  Trash2,
  ExternalLink,
  GitFork,
  LogOut,
  RefreshCw,
  UserPlus,
  Copy,
  Check
} from 'lucide-react';

interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'researcher' | 'viewer';
  groupSlugs: string[];
}

interface AuthProvidersInfo {
  oidcEnabled: boolean;
  localAuthEnabled: boolean;
  devMode: boolean;
  publicReportsRequireAuth: boolean;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  template_slug: string;
  status: string;
  idle_timeout_minutes: number;
  last_activity_at: string;
  my_role: string;
}

interface PublicationRow {
  id: string;
  project_id: string;
  project_slug: string;
  version: number;
  title: string;
  summary: string;
  git_commit_sha: string;
  template_slug: string;
  static_site_url: string;
  visibility: string;
  published_at: string;
}

interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  has_password: boolean;
  last_login_at: string | null;
}

type TabId = 'projects' | 'catalog' | 'admin';

export const App: React.FC = () => {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [providers, setProviders] = useState<AuthProvidersInfo>({
    oidcEnabled: false,
    localAuthEnabled: false,
    devMode: false,
    publicReportsRequireAuth: false
  });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('projects');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [publications, setPublications] = useState<PublicationRow[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUserRow[]>([]);
  const [adminData, setAdminData] = useState<{ templates: any[]; models: any[]; skills: any[]; mcp: any[] }>({
    templates: [],
    models: [],
    skills: [],
    mcp: []
  });

  // Login & Password Setup state (Demo local auth)
  const urlParams = new URLSearchParams(window.location.search);
  const [setupToken, setSetupToken] = useState(urlParams.get('setupToken') || '');
  const [loginEmail, setLoginEmail] = useState(urlParams.get('email') || '');
  const [loginPassword, setLoginPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Create project form
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('bio-standard');
  const [newIdleMin, setNewIdleMin] = useState(20);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  // Admin invite user form (Demo mode)
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'researcher' | 'admin' | 'viewer'>('researcher');
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const loadAll = async () => {
    try {
      const [provRes, meRes] = await Promise.all([fetch('/api/v1/auth/providers'), fetch('/api/v1/auth/me')]);
      if (provRes.ok) setProviders(await provRes.json());
      if (!meRes.ok) {
        setUser(null);
        setLoading(false);
        return;
      }
      const { user: me } = await meRes.json();
      setUser(me);

      const [pRes, pubRes] = await Promise.all([fetch('/api/v1/projects'), fetch('/api/v1/publications')]);
      if (pRes.ok) setProjects((await pRes.json()).projects || []);
      if (pubRes.ok) setPublications((await pubRes.json()).publications || []);

      if (me.role === 'admin') {
        const [t, m, s, mc, u] = await Promise.all([
          fetch('/api/v1/admin/config/template').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/model').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/skill').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/mcp').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/users').then((r) => (r.ok ? r.json() : { users: [] }))
        ]);
        setAdminData({ templates: t.items || [], models: m.items || [], skills: s.items || [], mcp: mc.items || [] });
        setAdminUsers(u.users || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const res = await fetch('/api/v1/auth/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password: loginPassword })
    });
    const out = await res.json();
    if (!res.ok) {
      setAuthError(out.error || 'Sign-in failed');
      return;
    }
    setLoginPassword('');
    await loadAll();
  };

  const handleSetupPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (loginPassword.length < 12) {
      setAuthError('Password must be at least 12 characters.');
      return;
    }
    if (loginPassword !== confirmPassword) {
      setAuthError('Passwords do not match.');
      return;
    }
    const res = await fetch('/api/v1/auth/local/setup-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, token: setupToken, password: loginPassword })
    });
    const out = await res.json();
    if (!res.ok) {
      setAuthError(out.error || 'Password setup failed');
      return;
    }
    setSetupToken('');
    setLoginPassword('');
    setConfirmPassword('');
    window.history.replaceState({}, '', '/');
    await loadAll();
  };

  const handleDevLogin = async () => {
    const res = await fetch('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.ok) await loadAll();
  };

  const handleLogout = async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    setUser(null);
  };

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    const res = await fetch('/api/v1/admin/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim(), displayName: inviteName.trim() || undefined, role: inviteRole })
    });
    const out = await res.json();
    if (!res.ok) {
      setStatusBanner(`Invite failed: ${out.error}`);
      return;
    }
    setInviteEmail('');
    setInviteName('');
    setLastInviteUrl(out.setupUrl);
    setCopiedInvite(false);
    setStatusBanner(`Invited ${out.email} (${out.role}). Share the one-time password setup link below.`);
    await loadAll();
  };

  const handleToggleUserStatus = async (u: AdminUserRow) => {
    const nextStatus = u.status === 'active' ? 'disabled' : 'active';
    const res = await fetch(`/api/v1/admin/users/${u.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    if (res.ok) {
      setStatusBanner(`User ${u.email} set to ${nextStatus}`);
      await loadAll();
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), templateSlug: newTemplate, idleTimeoutMinutes: newIdleMin })
    });
    const out = await res.json();
    if (!res.ok) {
      setStatusBanner(`Create failed: ${out.error || res.statusText}`);
    } else {
      setNewName('');
      setStatusBanner(`Created project ${out.id} (${out.status})`);
      await loadAll();
    }
  };

  const handleForkModule = async (pub: PublicationRow) => {
    const res = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${pub.title} (Fork)`, fromPublicationId: pub.id })
    });
    const out = await res.json();
    setStatusBanner(res.ok ? `Forked module into ${out.id}` : `Fork failed: ${out.error}`);
    if (res.ok) {
      setTab('projects');
      await loadAll();
    }
  };

  const handleReproduceModule = async (pubId: string) => {
    const res = await fetch(`/api/v1/publications/${pubId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const out = await res.json();
    setStatusBanner(res.ok ? `Started headless reproduction run ${out.runId}` : `Run failed: ${out.error}`);
  };

  const handleProjectAction = async (id: string, action: 'wake' | 'freeze' | 'delete') => {
    const res =
      action === 'delete'
        ? await fetch(`/api/v1/projects/${id}`, { method: 'DELETE' })
        : await fetch(`/api/v1/projects/${id}/${action}`, { method: 'POST' });
    const out = await res.json();
    setStatusBanner(res.ok ? `${id}: ${out.status}` : `Action failed: ${out.error}`);
    await loadAll();
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading Bionic Hub…</div>;
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-2xl space-y-5">
          <div className="flex items-center space-x-3">
            <FlaskConical className="w-8 h-8 text-sky-400" />
            <div>
              <h1 className="text-xl font-semibold text-white">Bionic Hub</h1>
              <p className="text-xs text-slate-400">
                {setupToken ? 'Set up your password to activate your account' : 'Enterprise Scientific Analysis & Reproducible Modules'}
              </p>
            </div>
          </div>

          {authError && (
            <div className="rounded-lg border border-rose-800 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
              {authError}
            </div>
          )}

          {setupToken ? (
            <form onSubmit={handleSetupPassword} className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Invited Email</label>
                <input
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">New Password (min 12 characters)</label>
                <input
                  type="password"
                  required
                  minLength={12}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Confirm Password</label>
                <input
                  type="password"
                  required
                  minLength={12}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <button
                type="submit"
                className="block w-full rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium py-2.5 text-sm transition"
              >
                Set Password & Sign In
              </button>
            </form>
          ) : (
            <>
              {providers.localAuthEnabled && (
                <form onSubmit={handleLocalLogin} className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Email</label>
                    <input
                      type="email"
                      required
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      placeholder="scientist@example.com"
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Password</label>
                    <input
                      type="password"
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    className="block w-full rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium py-2.5 text-sm transition"
                  >
                    Sign In with Email & Password
                  </button>
                </form>
              )}

              {providers.oidcEnabled && (
                <a
                  href="/api/v1/auth/oidc/login"
                  className="block w-full text-center rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 font-medium py-2.5 text-sm transition"
                >
                  Sign in with SSO (OIDC)
                </a>
              )}

              {providers.devMode && (
                <button
                  onClick={handleDevLogin}
                  className="block w-full text-center rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-sm py-2 transition"
                >
                  Local Development Sign-In
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <FlaskConical className="w-6 h-6 text-sky-400" />
            <span className="font-semibold text-white">Bionic Hub</span>
          </div>
          <nav className="flex items-center space-x-1 text-sm">
            <button
              onClick={() => setTab('projects')}
              className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 ${tab === 'projects' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <FolderGit2 className="w-4 h-4" />
              <span>Projects ({projects.length})</span>
            </button>
            <button
              onClick={() => setTab('catalog')}
              className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 ${tab === 'catalog' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <BookOpen className="w-4 h-4" />
              <span>Completed Modules ({publications.length})</span>
            </button>
            {user.role === 'admin' && (
              <button
                onClick={() => setTab('admin')}
                className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 ${tab === 'admin' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>Admin</span>
              </button>
            )}
          </nav>
        </div>
        <div className="flex items-center space-x-3 text-sm">
          <span className="text-slate-400">{user.email} ({user.role})</span>
          <button onClick={loadAll} className="p-1.5 rounded hover:bg-slate-800 text-slate-400" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={handleLogout} className="p-1.5 rounded hover:bg-slate-800 text-slate-400" title="Sign out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {statusBanner && (
        <div className="bg-sky-950/60 border-b border-sky-800 px-6 py-2 text-xs text-sky-200 flex items-center justify-between">
          <span>{statusBanner}</span>
          <button onClick={() => setStatusBanner(null)} className="text-sky-400 hover:text-white">Dismiss</button>
        </div>
      )}

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 space-y-6">
        {tab === 'projects' && (
          <>
            <form onSubmit={handleCreateProject} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-slate-400 mb-1">New Project Name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Kidney Cohort RNA-seq DEG"
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">VM Template</label>
                <input
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value)}
                  className="w-44 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Idle Freeze (min)</label>
                <input
                  type="number"
                  min={5}
                  max={180}
                  value={newIdleMin}
                  onChange={(e) => setNewIdleMin(Number(e.target.value))}
                  className="w-24 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <button type="submit" className="rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium px-4 py-2 text-sm flex items-center space-x-1.5">
                <Plus className="w-4 h-4" />
                <span>Create Project</span>
              </button>
            </form>

            <div className="grid gap-4 md:grid-cols-2">
              {projects.map((p) => (
                <div key={p.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <h2 className="font-semibold text-white">{p.name}</h2>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-sky-300 font-mono">{p.status}</span>
                    </div>
                    <p className="text-xs text-slate-400 font-mono mt-1">{p.id} · {p.template_slug} · idle {p.idle_timeout_minutes}m</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <a
                      href={`/api/v1/auth/handoff?scope=editor&resource=${p.id}&next=/`}
                      className="px-3 py-1.5 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 flex items-center space-x-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open Editor</span>
                    </a>
                    {p.status !== 'running' && (
                      <button onClick={() => handleProjectAction(p.id, 'wake')} className="px-2.5 py-1.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 flex items-center space-x-1">
                        <Play className="w-3.5 h-3.5" />
                        <span>Wake</span>
                      </button>
                    )}
                    {p.status === 'running' && (
                      <button onClick={() => handleProjectAction(p.id, 'freeze')} className="px-2.5 py-1.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 flex items-center space-x-1">
                        <Snowflake className="w-3.5 h-3.5" />
                        <span>Freeze</span>
                      </button>
                    )}
                    <button onClick={() => handleProjectAction(p.id, 'delete')} className="ml-auto p-1.5 rounded text-slate-500 hover:text-rose-400" title="Delete project">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
              {projects.length === 0 && (
                <p className="text-sm text-slate-500 col-span-2">No active projects yet. Create a new project above or fork a completed analysis module.</p>
              )}
            </div>
          </>
        )}

        {tab === 'catalog' && (
          <div className="grid gap-4 md:grid-cols-2">
            {publications.map((pub) => (
              <div key={pub.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-white">{pub.title} <span className="text-slate-400 text-xs">v{pub.version}</span></h2>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-emerald-300">{pub.visibility}</span>
                </div>
                <p className="text-xs text-slate-400">{pub.summary || 'Self-contained reproducible analysis module (published report + pinned Git code + manifest data).'}</p>
                <p className="text-xs font-mono text-slate-500">{pub.id} · commit {pub.git_commit_sha.slice(0, 10)} · {pub.template_slug}</p>
                <div className="flex items-center gap-2 text-xs pt-1">
                  <a href={pub.static_site_url} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 flex items-center space-x-1">
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>View Report</span>
                  </a>
                  <button onClick={() => handleForkModule(pub)} className="px-3 py-1.5 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 flex items-center space-x-1">
                    <GitFork className="w-3.5 h-3.5" />
                    <span>Create Project from Module</span>
                  </button>
                  <button onClick={() => handleReproduceModule(pub.id)} className="px-3 py-1.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 flex items-center space-x-1">
                    <Play className="w-3.5 h-3.5" />
                    <span>Reproduce</span>
                  </button>
                </div>
              </div>
            ))}
            {publications.length === 0 && (
              <p className="text-sm text-slate-500 col-span-2">No published analysis modules yet. Publish a project from Bionic Editor (`scripts/publish.sh`) to list it here.</p>
            )}
          </div>
        )}

        {tab === 'admin' && (
          <div className="space-y-6">
            {providers.localAuthEnabled && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-white text-sm flex items-center space-x-2">
                      <UserPlus className="w-4 h-4 text-sky-400" />
                      <span>Demo Users (Manual Invite & Password Setup)</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Add demo users manually and share their one-time password setup link.
                      {providers.publicReportsRequireAuth && ' Publication site requires login.'}
                    </p>
                  </div>
                </div>

                <form onSubmit={handleInviteUser} className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs text-slate-400 mb-1">Email</label>
                    <input
                      type="email"
                      required
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@company.com"
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div className="w-44">
                    <label className="block text-xs text-slate-400 mb-1">Display Name</label>
                    <input
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div className="w-36">
                    <label className="block text-xs text-slate-400 mb-1">Role</label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as any)}
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                    >
                      <option value="researcher">Researcher</option>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <button type="submit" className="rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium px-4 py-2 text-sm">
                    Add & Generate Setup Link
                  </button>
                </form>

                {lastInviteUrl && (
                  <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 flex items-center justify-between gap-2 text-xs">
                    <code className="text-emerald-200 truncate">{lastInviteUrl}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(lastInviteUrl);
                        setCopiedInvite(true);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 flex items-center space-x-1"
                    >
                      {copiedInvite ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedInvite ? 'Copied' : 'Copy Link'}</span>
                    </button>
                  </div>
                )}

                <div className="space-y-1.5 text-xs">
                  {adminUsers.map((u) => (
                    <div key={u.id} className="p-2.5 rounded bg-slate-950 border border-slate-800 flex items-center justify-between">
                      <div>
                        <span className="font-medium text-slate-200">{u.email}</span>
                        <span className="ml-2 text-slate-500 font-mono">
                          {u.role} · {u.has_password ? 'password set' : 'pending setup'} · {u.status}
                        </span>
                      </div>
                      {u.id !== user.id && (
                        <button
                          onClick={() => handleToggleUserStatus(u)}
                          className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
                        >
                          {u.status === 'active' ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              {[
                ['VM Image Templates', adminData.templates],
                ['Configured Models (Direct & AWS Bedrock)', adminData.models],
                ['Managed Skills', adminData.skills],
                ['MCP Server Connections', adminData.mcp]
              ].map(([title, list]) => (
                <div key={title as string} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
                  <h2 className="font-semibold text-white text-sm">{title as string}</h2>
                  {(list as any[]).length === 0 ? (
                    <p className="text-xs text-slate-500">None registered. Sync via GitOps CI (`bionic-ctl apply --dir infra/config-examples`).</p>
                  ) : (
                    <ul className="space-y-2 text-xs">
                      {(list as any[]).map((item) => (
                        <li key={item.slug} className="p-2.5 rounded bg-slate-950 border border-slate-800 flex items-center justify-between">
                          <div>
                            <div className="font-medium text-slate-200">{item.display_name || item.slug}</div>
                            <div className="font-mono text-slate-500">{item.slug} · v{item.version}</div>
                          </div>
                          <span className="text-slate-400 font-mono">{item.provider_type || item.transport || 'gcp'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
