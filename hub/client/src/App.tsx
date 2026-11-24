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
  RefreshCw
} from 'lucide-react';

interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'researcher' | 'viewer';
  groupSlugs: string[];
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

type TabId = 'projects' | 'catalog' | 'admin';

export const App: React.FC = () => {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('projects');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [publications, setPublications] = useState<PublicationRow[]>([]);
  const [adminData, setAdminData] = useState<{ templates: any[]; models: any[]; skills: any[]; mcp: any[] }>({
    templates: [],
    models: [],
    skills: [],
    mcp: []
  });
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('bio-standard');
  const [newIdleMin, setNewIdleMin] = useState(20);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const loadAll = async () => {
    try {
      const meRes = await fetch('/api/v1/auth/me');
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
        const [t, m, s, mc] = await Promise.all([
          fetch('/api/v1/admin/config/template').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/model').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/skill').then((r) => (r.ok ? r.json() : { items: [] })),
          fetch('/api/v1/admin/config/mcp').then((r) => (r.ok ? r.json() : { items: [] }))
        ]);
        setAdminData({ templates: t.items || [], models: m.items || [], skills: s.items || [], mcp: mc.items || [] });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

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
      body: JSON.stringify({
        name: `${pub.title} (Fork)`,
        fromPublicationId: pub.id
      })
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
              <p className="text-xs text-slate-400">Enterprise Scientific Analysis & Reproducible Modules</p>
            </div>
          </div>
          <a
            href="/api/v1/auth/oidc/login"
            className="block w-full text-center rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium py-2.5 transition"
          >
            Sign in with SSO (OIDC)
          </a>
          <button
            onClick={handleDevLogin}
            className="block w-full text-center rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-sm py-2 transition"
          >
            Local Development Sign-In
          </button>
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
        )}
      </main>
    </div>
  );
};
