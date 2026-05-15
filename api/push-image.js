module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers['authorization'];
  if (process.env.API_SECRET && authHeader !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { url, path } = req.body;
  if (!url || !path) {
    return res.status(400).json({ error: 'url and path are required' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = 'agence-disko';
  const GITHUB_REPO = 'veille-dessange';

  // Step 1: Get downloadable thumbnail via TikTok oEmbed
  let thumbnailUrl;
  try {
    const oembedRes = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }
    );
    if (!oembedRes.ok) {
      return res.status(400).json({ error: `oEmbed failed: ${oembedRes.status}` });
    }
    const oembed = await oembedRes.json();
    thumbnailUrl = oembed.thumbnail_url;
    if (!thumbnailUrl) {
      return res.status(400).json({ error: 'oEmbed returned no thumbnail_url' });
    }
  } catch (err) {
    return res.status(500).json({ error: `oEmbed error: ${err.message}` });
  }

  // Step 2: Download thumbnail image
  const imgRes = await fetch(thumbnailUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.tiktok.com/'
    }
  });
  if (!imgRes.ok) {
    return res.status(400).json({ error: `Image download failed: ${imgRes.status}`, thumbnailUrl });
  }
  const buffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  // Step 3: Push to GitHub (with SHA retry on 409)
  async function getSha() {
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'veille-proxy', 'Cache-Control': 'no-cache' } }
    );
    if (r.ok) { const d = await r.json(); return d.sha; }
    return undefined;
  }

  async function pushToGithub(b64, sha, attempt) {
    const body = { message: `Add thumbnail ${path}`, content: b64, branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'veille-proxy'
        },
        body: JSON.stringify(body)
      }
    );
    if (r.status === 409 && attempt < 3) {
      const freshSha = await getSha();
      return pushToGithub(b64, freshSha, attempt + 1);
    }
    return r;
  }

  try {
    const sha = await getSha();
    const pushRes = await pushToGithub(base64, sha, 1);
    if (!pushRes.ok) {
      const errText = await pushRes.text();
      return res.status(500).json({ error: `GitHub push failed: ${pushRes.status}`, detail: errText });
    }
    return res.status(200).json({
      url: `https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}/${path}`,
      pushed: true
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
