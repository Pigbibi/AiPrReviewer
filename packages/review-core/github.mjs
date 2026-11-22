// Minimal GitHub REST API client using fetch (Web Standard).

const API_BASE = 'https://api.github.com';

async function ghFetch(path, token, options = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ai-pr-reviewer/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function getInstallationToken(appJwt, installationId, fetchImpl = fetch) {
  const data = await ghFetch(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    { method: 'POST' },
    fetchImpl
  );
  return data.token;
}

export async function fetchPrContext(owner, repo, prNumber, token, fetchImpl = fetch) {
  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token, {}, fetchImpl);
  const files = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, token, {}, fetchImpl);
  const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, token, {}, fetchImpl);
  let agentsMd = '';
  try {
    const doc = await ghFetch(
      `/repos/${owner}/${repo}/contents/AGENTS.md?ref=${encodeURIComponent(pr.base.ref)}`,
      token,
      {},
      fetchImpl
    );
    if (doc && doc.content) {
      agentsMd = atob(doc.content.replace(/\n/g, ''));
    }
  } catch {
    agentsMd = '';
  }
  return { pr, files, comments, agentsMd };
}

export async function postPrComment(owner, repo, prNumber, body, token, fetchImpl = fetch) {
  return ghFetch(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
    fetchImpl
  );
}
