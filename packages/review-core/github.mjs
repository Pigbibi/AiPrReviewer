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

function decodeBase64Utf8(b64) {
  const bin = atob(String(b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function fetchRepoFile(owner, repo, filePath, ref, token, fetchImpl = fetch) {
  try {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const doc = await ghFetch(
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      token,
      {},
      fetchImpl
    );
    if (doc && doc.content) {
      return decodeBase64Utf8(doc.content);
    }
  } catch {
    return '';
  }
  return '';
}

export async function fetchPrContext(owner, repo, prNumber, token, fetchImpl = fetch, relatedPaths = []) {
  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token, {}, fetchImpl);
  const files = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, token, {}, fetchImpl);
  const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, token, {}, fetchImpl);
  const agentsMd = await fetchRepoFile(owner, repo, 'AGENTS.md', pr.base.ref, token, fetchImpl);
  const relatedFiles = [];
  for (const relPath of relatedPaths.slice(0, 3)) {
    const content = await fetchRepoFile(owner, repo, relPath, pr.head.sha, token, fetchImpl);
    if (content) relatedFiles.push({ path: relPath, content });
  }
  return { pr, files, comments, agentsMd, relatedFiles };
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
