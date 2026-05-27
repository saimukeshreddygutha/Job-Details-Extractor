/* Job Details Extractor — content script
 *
 * Floating, draggable green button that runs on:
 *   - jobright.ai/jobs/info/*
 *   - www.linkedin.com/jobs/view/*, /jobs/search/*, /jobs/collections/*
 *
 * Click  -> extracts the current job from the page and saves it to the
 *           local tracked list (chrome.storage.local.tracked_jobs).
 * Drag   -> moves the button. Position is persisted and shared across sites.
 *
 * Local dedupe in handleSave():
 *   1. Same job_id   => refresh in place ("Updated ✓").
 *   2. Same role at  => normalize(title) + normalize(company) match an
 *      same company      existing entry from another id (e.g. jobright vs
 *                        linkedin) => skipped ("Already tracked at this
 *                        company"). Backend does the same check at push time.
 *
 * Each site has its own extractor. The shape returned is identical and the
 * keys match the public.jobs columns.
 */
(function () {
  'use strict';

  const BTN_ID = 'jr-extractor-btn';
  const TOAST_ID = 'jr-extractor-toast';
  const POS_KEY = 'jr_btn_pos';
  const DRAG_THRESHOLD = 5; // px of movement before a press counts as a drag

  const HOST = location.hostname;
  const IS_JOBRIGHT = /(^|\.)jobright\.ai$/.test(HOST);
  const IS_LINKEDIN = /(^|\.)linkedin\.com$/.test(HOST);

  /* --------------------------------------------------- shared helpers ----- */

  function readJSONById(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  // Turn HTML into readable plain text. Block-level tags emit a blank line so
  // sections stay visually separated; <li> becomes "- item".
  function htmlToText(html) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [];
    const BLOCK = new Set([
      'p', 'ul', 'ol', 'div', 'section', 'article',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);

    function walk(node) {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t) lines.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'br') {
            lines.push('');
          } else if (tag === 'li') {
            const t = child.textContent.replace(/\s+/g, ' ').trim();
            if (t) lines.push('- ' + t);
          } else if (BLOCK.has(tag)) {
            walk(child);
            lines.push('');
          } else {
            walk(child);
          }
        }
      });
    }

    walk(doc.body);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || null;
  }

  function normalize(s) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // LinkedIn only exposes relative phrasing ("21 hours ago") on the JDP — no
  // absolute timestamp is rendered. Convert at scrape time so date_posted
  // stores ISO 8601 like jobright's job.publishTime, and the dashboard can
  // format both sources the same way. Months are approximated to 30 days,
  // which matches LinkedIn's own precision at that scale.
  function relativeToIso(rel) {
    if (!rel) return null;
    const m = String(rel).match(/(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const msPer = {
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 7 * 86400000,
      month: 30 * 86400000,
    }[m[2].toLowerCase()];
    if (!msPer) return null;
    return new Date(Date.now() - n * msPer).toISOString();
  }

  /* ----------------------------------------------------- site: jobright --- */
  //
  // Jobright is a Next.js SPA. When you navigate between jobs without a full
  // reload, the server-rendered #__NEXT_DATA__ keeps the FIRST job's data,
  // while the URL and head-managed scripts (#jobright-helper-job-detail-info,
  // #job-posting) update to the current job. So we trust the URL for the
  // current job_id and pick the data source that matches it; #__NEXT_DATA__
  // is only a fallback for a hard page load.
  function extractFromJobright() {
    const helper = readJSONById('jobright-helper-job-detail-info');
    const jobPosting = readJSONById('job-posting');
    const nextData = readJSONById('__NEXT_DATA__');

    const ndDs =
      (nextData &&
        nextData.props &&
        nextData.props.pageProps &&
        nextData.props.pageProps.dataSource) ||
      {};

    const m = location.pathname.match(/\/jobs\/info\/([^/?#]+)/);
    const urlJobId = m ? m[1] : null;

    const candidates = [];
    if (helper && helper.jobResult) {
      candidates.push({ job: helper.jobResult, company: helper.companyResult || {} });
    }
    if (ndDs.jobResult) {
      candidates.push({ job: ndDs.jobResult, company: ndDs.companyResult || {} });
    }

    const picked =
      candidates.find((c) => urlJobId && c.job && c.job.jobId === urlJobId) ||
      candidates[0] ||
      { job: {}, company: {} };
    const job = picked.job || {};
    const company = picked.company || {};

    const jp = jobPosting || {};
    const jpId = jp.identifier && jp.identifier.value ? jp.identifier.value : null;
    const jpLoc =
      jp.jobLocation && jp.jobLocation.address
        ? jp.jobLocation.address.addressLocality
        : null;
    const hiring = jp.hiringOrganization || {};

    const jobId = job.jobId || urlJobId || jpId || null;
    const jpFresh = jpId ? jpId === jobId : false;

    // Jobright's helper field names have shifted across pages and the real JD
    // often lives as 2-3 separate section fields (responsibilities / required
    // quals / preferred quals) that are individually shorter than the AI
    // summary blurb — so a "longest top-level string wins" strategy drops the
    // real JD on those pages. Strategy: walk helper.jobResult recursively,
    // classify each long-enough string by its key path, then stitch sections.
    function looksLikeDescription(s) {
      if (typeof s !== 'string') return false;
      const t = s.trim();
      if (t.length < 80) return false;
      if (/^https?:\/\//i.test(t)) return false;
      if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false;
      if (!/\s/.test(t)) return false;
      return true;
    }

    function classifyByPath(path) {
      const p = path.toLowerCase();
      if (/summary|nlpdesc|tldr|brief/.test(p)) return 'skip';
      if (/preferred|nicetohave|nice_to_have/.test(p)) return 'preferred';
      if (/responsibilit|duti|whatyou.*do/.test(p)) return 'responsibilities';
      if (/qualific|requirement|required|musthave|must_have|skill/.test(p)) return 'required';
      if (/description|jobdetail|jobbody|content|body/.test(p)) return 'description';
      return 'other';
    }

    function pickJd() {
      const findings = [];

      function pushString(path, raw) {
        if (!looksLikeDescription(raw)) return;
        const t = (htmlToText(raw) || raw).trim();
        if (t.length < 80) return;
        findings.push({ path, text: t });
      }

      function walk(node, path) {
        if (node == null) return;
        if (typeof node === 'string') {
          pushString(path, node);
          return;
        }
        if (Array.isArray(node)) {
          const allStrings = node.length > 0 && node.every((x) => typeof x === 'string');
          if (allStrings) {
            const joined = node
              .map((s) => '- ' + s.replace(/\s+/g, ' ').trim())
              .filter((s) => s.length > 2)
              .join('\n');
            pushString(path, joined);
            return;
          }
          node.forEach((v, i) => walk(v, path + '[' + i + ']'));
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            walk(v, path ? path + '.' + k : k);
          }
        }
      }
      walk(job, '');

      if (jpFresh && typeof jp.description === 'string') {
        const t = htmlToText(jp.description);
        if (t && t.trim().length >= 80) {
          findings.push({ path: 'jp.description', text: t.trim() });
        }
      }

      const classified = findings.map((f) => Object.assign({}, f, { section: classifyByPath(f.path) }));

      try {
        console.log(
          '[Job Extractor] JD candidates for ' + jobId + ':',
          classified.map((c) => ({ src: c.path, section: c.section, len: c.text.length, preview: c.text.slice(0, 80) }))
        );
      } catch (e) {}

      const longest = { responsibilities: null, required: null, preferred: null };
      let descBlob = null;
      let otherBlob = null;
      for (const f of classified) {
        if (f.section === 'skip') continue;
        if (f.section in longest) {
          const cur = longest[f.section];
          if (!cur || f.text.length > cur.length) longest[f.section] = f.text;
        } else if (f.section === 'description') {
          if (!descBlob || f.text.length > descBlob.length) descBlob = f.text;
        } else {
          if (!otherBlob || f.text.length > otherBlob.length) otherBlob = f.text;
        }
      }

      function splitItems(text) {
        if (!text) return [];
        let items = text.split(/\n+/).map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
        if (items.length <= 1 && text.includes(' - ')) {
          items = text.replace(/^[-*•]\s*/, '').split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
        }
        return items;
      }

      function stripOverlap(text, otherText) {
        if (!text || !otherText) return text;
        const otherItems = splitItems(otherText).map((s) => s.toLowerCase()).filter(Boolean);
        if (otherItems.length === 0) return text;
        const kept = splitItems(text).filter((item) => {
          const lower = item.toLowerCase();
          return !otherItems.some((p) => lower === p || lower.includes(p) || p.includes(lower));
        });
        if (kept.length === 0) return null;
        return kept.map((i) => '- ' + i).join('\n');
      }

      if (longest.required && longest.preferred) {
        longest.required = stripOverlap(longest.required, longest.preferred) || longest.required;
      }

      const stitched = [];
      if (longest.responsibilities) stitched.push('Responsibilities\n' + longest.responsibilities);
      if (longest.required) stitched.push('Required Qualifications\n' + longest.required);
      if (longest.preferred) stitched.push('Preferred Qualifications\n' + longest.preferred);

      if (stitched.length) return stitched.join('\n\n');
      if (descBlob) return descBlob;
      if (otherBlob) return otherBlob;
      return null;
    }

    return {
      job_id: jobId,
      company: company.companyName || hiring.name || null,
      title: job.jobTitle || job.jobNlpTitle || (jpFresh ? jp.title : null) || null,
      jd: pickJd(),
      apply_url: job.applyLink || job.originalUrl || (jpFresh ? jp.url : null) || null,
      company_desc: company.companyDesc || null,
      company_url: company.companyURL || (jpFresh ? hiring.sameAs : null) || null,
      date_posted: job.publishTime || (jpFresh ? jp.datePosted : null) || null,
      locations: job.jobLocation || (jpFresh ? jpLoc : null) || null,
      employment_type: job.employmentType || (jpFresh ? jp.employmentType : null) || null,
      scraped_at: new Date().toISOString(),
    };
  }

  /* ----------------------------------------------------- site: linkedin --- */
  //
  // LinkedIn is an Ember SPA. The visible JDP DOM is the only source we can
  // trust on SPA navigation — the bpr-guid-* code blocks in the initial HTML
  // are stale after switching jobs in the side pane.
  //
  // Strategy: read job_id from the URL (path on /jobs/view/<id>/, query
  // ?currentJobId=<id> on search/collections), then scrape the JDP top card
  // and description from the live DOM.
  function extractFromLinkedIn() {
    let jobId = null;
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) {
      jobId = m[1];
    } else {
      const cur = new URLSearchParams(location.search).get('currentJobId');
      if (cur && /^\d+$/.test(cur)) jobId = cur;
    }

    // SDUI rewrite (late 2025): the old semantic class names are gone — the
    // visible DOM uses hashed class names that change with every deploy. The
    // company anchor is the only structural element with a stable hook
    // (aria-label="Company, <Name>."), so we use it both as a fallback signal
    // and as the anchor we walk up from to scope the top card.
    const companyAnchor = document.querySelector(
      'a[aria-label^="Company, "], [aria-label^="Company, "]'
    );

    let topCard =
      document.querySelector('.job-details-jobs-unified-top-card') ||
      document.querySelector('.jobs-details') ||
      document.querySelector('.jobs-search__job-details--container');
    if (!topCard && companyAnchor) {
      // Walk up until we find an ancestor that actually contains the "X ago"
      // timestamp — that's the smallest container guaranteed to enclose the
      // whole top card (title + location + date + insight pills). A fixed
      // depth walk lands inconsistently across promoted vs. organic layouts.
      const AGO_RE = /\d+\s*(?:minute|hour|day|week|month)s?\s+ago/i;
      let node = companyAnchor.parentElement;
      while (node && node !== document.body) {
        if (AGO_RE.test(node.textContent || '')) {
          topCard = node;
          break;
        }
        node = node.parentElement;
      }
      if (!topCard) topCard = companyAnchor.parentElement;
    }
    if (!topCard) topCard = document.querySelector('main') || document.body;

    function text(el) {
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    }

    // Title
    let title = null;
    {
      const h1 = topCard.querySelector('h1');
      if (h1) title = text(h1);
      if (!title) {
        const t = topCard.querySelector(
          '.job-details-jobs-unified-top-card__job-title, [class*="job-title"]'
        );
        if (t) title = text(t);
      }
      // SDUI: no h1 on the page; parse from <title> "Title | Company | LinkedIn".
      if (!title && document.title) {
        const parts = document.title.split(' | ').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 3 && /linkedin/i.test(parts[parts.length - 1])) {
          title = parts.slice(0, parts.length - 2).join(' | ') || null;
        } else if (parts.length === 2 && /linkedin/i.test(parts[1])) {
          title = parts[0];
        } else if (parts.length) {
          title = parts[0];
        }
      }
    }

    // Company name + page URL
    let company = null;
    let companyUrl = null;
    {
      const a =
        topCard.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
        topCard.querySelector('[class*="company-name"] a');
      if (a) {
        company = text(a);
        try {
          const href = a.getAttribute('href') || a.href;
          if (href) {
            const u = new URL(href, location.origin);
            // Strip "/life", "/jobs", "/posts", "/people" suffixes to keep the
            // canonical company page URL.
            const path = u.pathname.replace(/\/(life|jobs|posts|people)\/?$/, '/');
            companyUrl = (u.origin + path).replace(/\/$/, '');
          }
        } catch (e) {}
      }
      if (!company) {
        const c = topCard.querySelector(
          '.job-details-jobs-unified-top-card__company-name, [class*="company-name"]'
        );
        if (c) company = text(c);
      }
      // SDUI: derive from the aria-label="Company, <Name>." anchor.
      if (companyAnchor) {
        if (!company) {
          const lab = companyAnchor.getAttribute('aria-label') || '';
          const mm = lab.match(/^Company,\s*(.+?)\.?$/);
          if (mm) company = mm[1].trim();
        }
        if (!companyUrl) {
          const link =
            (companyAnchor.tagName === 'A' && companyAnchor) ||
            companyAnchor.querySelector('a[href*="/company/"]') ||
            companyAnchor.closest('a[href*="/company/"]');
          if (link) {
            try {
              const href = link.getAttribute('href') || link.href;
              if (href) {
                const u = new URL(href, location.origin);
                const path = u.pathname.replace(/\/(life|jobs|posts|people)\/?$/, '/');
                companyUrl = (u.origin + path).replace(/\/$/, '');
              }
            } catch (e) {}
          }
        }
      }
      // Last resort: parse company from <title> "Title | Company | LinkedIn".
      if (!company && document.title) {
        const parts = document.title.split(' | ').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 3 && /linkedin/i.test(parts[parts.length - 1])) {
          company = parts[parts.length - 2] || null;
        }
      }
    }

    // Primary description row: typically "Location · Reposted 2 days ago · 47 applicants"
    let locations = null;
    let datePosted = null;
    {
      const pd = topCard.querySelector(
        '.job-details-jobs-unified-top-card__primary-description-container,' +
        '.job-details-jobs-unified-top-card__primary-description'
      );
      if (pd) {
        const raw = text(pd) || '';
        const parts = raw.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);
        if (parts.length) locations = parts[0];
        const ago = parts.find((p) => /\bago\b/i.test(p));
        if (ago) datePosted = ago;
      }
      // SDUI: anchor both fields off the "X ago" timestamp. LinkedIn always
      // renders the row as "<Location> · <X ago> · <other>" (sometimes with •),
      // so locating "ago" in the top-card text gives us the timestamp directly,
      // and the segment immediately before the nearest separator is the
      // location. Robust to promoted-vs-organic layout differences and to the
      // company-name container not being on the same line as the date.
      if (!datePosted || !locations) {
        const scopeText = (topCard.textContent || '').replace(/\s+/g, ' ').trim();
        const ago = scopeText.match(/(?:Posted\s+|Reposted\s+)?(\d+\s*(?:minute|hour|day|week|month)s?\s+ago)/i);
        if (ago) {
          if (!datePosted) datePosted = ago[1];
          if (!locations) {
            const before = scopeText.slice(0, ago.index).trimEnd();
            const sep = Math.max(before.lastIndexOf('·'), before.lastIndexOf('•'));
            if (sep >= 0) locations = before.slice(sep + 1).trim();
          }
        }
      }
    }

    // Employment type from the job insight pills, fallback to scanning topCard text.
    let employmentType = null;
    {
      const ET = /\b(Full-time|Part-time|Contract|Internship|Temporary|Volunteer)\b/i;
      const insightSel =
        '.job-details-jobs-unified-top-card__job-insight,' +
        '.job-details-fit-level-preferences,' +
        '.jobs-unified-top-card__job-insight';
      const insightEls = topCard.querySelectorAll(insightSel);
      for (const el of insightEls) {
        const m2 = (text(el) || '').match(ET);
        if (m2) {
          employmentType = m2[1];
          break;
        }
      }
      if (!employmentType) {
        const m2 = (text(topCard) || '').match(ET);
        if (m2) employmentType = m2[1];
      }
    }

    // Description: the inner #job-details div holds the full rendered HTML,
    // even when the visual "see more" is collapsed.
    let jd = null;
    {
      const desc =
        document.querySelector('#job-details') ||
        document.querySelector('.jobs-description__content .jobs-box__html-content') ||
        document.querySelector('.jobs-description-content__text') ||
        document.querySelector('.jobs-description__container');
      if (desc) jd = htmlToText(desc.innerHTML);
      // SDUI: no #job-details / .jobs-description__* anymore. Fall back to the
      // largest text-dense block under <main> that isn't part of the top card
      // and isn't mostly links/buttons.
      if (!jd) {
        const root = document.querySelector('main') || document.body;
        let bestEl = null;
        let bestLen = 0;
        root.querySelectorAll('div, section, article').forEach((el) => {
          if (topCard && (topCard.contains(el) || el.contains(topCard))) return;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length < 600) return;
          const interactiveText = Array.from(el.querySelectorAll('a, button'))
            .reduce((s, x) => s + (x.textContent || '').length, 0);
          if (interactiveText > t.length * 0.4) return;
          if (t.length > bestLen) {
            bestLen = t.length;
            bestEl = el;
          }
        });
        if (bestEl) jd = htmlToText(bestEl.innerHTML);
      }
    }

    // Apply URL: canonical LinkedIn job page works for both Easy Apply (no
    // external URL exists) and external apply (clicking through still works).
    const applyUrl = jobId ? 'https://www.linkedin.com/jobs/view/' + jobId + '/' : null;

    return {
      job_id: jobId,
      company: company || null,
      title: title || null,
      jd: jd,
      apply_url: applyUrl,
      company_desc: null, // not available on JDP; would need an extra company-page fetch
      company_url: companyUrl,
      date_posted: relativeToIso(datePosted) || datePosted,
      locations: locations,
      employment_type: employmentType,
      scraped_at: new Date().toISOString(),
    };
  }

  function extractJob() {
    if (IS_LINKEDIN) return extractFromLinkedIn();
    if (IS_JOBRIGHT) return extractFromJobright();
    return null;
  }

  /* --------------------------------------------------------------- save --- */

  function handleSave() {
    const data = extractJob();

    try {
      console.group('[Job Extractor] save ' + (data && data.job_id ? data.job_id : '(no id)'));
      console.log('host:', HOST, 'is_linkedin:', IS_LINKEDIN, 'is_jobright:', IS_JOBRIGHT);
      console.log('extracted:', data);
      console.log('jd length:', data && data.jd ? data.jd.length : 0);
      console.groupEnd();
    } catch (e) {}

    if (!data || !data.job_id) {
      showToast('No job found');
      return;
    }
    if (!data.title) {
      showToast('Page not ready — try again');
      return;
    }

    try {
      chrome.storage.local.get('tracked_jobs', (res) => {
        const jobs = (res && res.tracked_jobs) || {};

        // Dedupe 1: exact job_id => refresh in place
        if (Object.prototype.hasOwnProperty.call(jobs, data.job_id)) {
          jobs[data.job_id] = data;
          chrome.storage.local.set({ tracked_jobs: jobs }, () => {
            if (chrome.runtime.lastError) showToast('Save failed');
            else showToast('Updated ✓');
          });
          return;
        }

        // Dedupe 2: same role + same company under a different id
        // (e.g. tracked from jobright, now revisiting on linkedin).
        const nt = normalize(data.title);
        const nc = normalize(data.company);
        if (nt && nc) {
          const dup = Object.keys(jobs).find((id) => {
            const j = jobs[id] || {};
            return normalize(j.title) === nt && normalize(j.company) === nc;
          });
          if (dup) {
            showToast('Already tracked at this company');
            return;
          }
        }

        // New job
        jobs[data.job_id] = data;
        chrome.storage.local.set({ tracked_jobs: jobs }, () => {
          if (chrome.runtime.lastError) {
            showToast('Save failed');
          } else {
            const jdLen = data.jd ? data.jd.length : 0;
            showToast(jdLen ? 'Saved ✓ (JD ' + jdLen + ' chars)' : 'Saved — no JD found');
          }
        });
      });
    } catch (e) {
      showToast('Save failed');
    }
  }

  /* -------------------------------------------------------------- toast --- */

  function showToast(msg) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('jr-toast-show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(
      () => toast.classList.remove('jr-toast-show'),
      1800
    );
  }

  /* ----------------------------------------------------------- position --- */

  function applyPosition(btn, left, top) {
    const size = btn.offsetWidth || 56;
    left = Math.max(0, Math.min(left, window.innerWidth - size));
    top = Math.max(0, Math.min(top, window.innerHeight - size));
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }

  function restorePosition(btn) {
    try {
      chrome.storage.local.get(POS_KEY, (res) => {
        const pos = res && res[POS_KEY];
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
          applyPosition(btn, pos.left, pos.top);
        }
      });
    } catch (e) {
      /* storage unavailable — keep default CSS position */
    }
  }

  function savePosition(btn) {
    const rect = btn.getBoundingClientRect();
    try {
      chrome.storage.local.set({ [POS_KEY]: { left: rect.left, top: rect.top } });
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------------- drag --- */

  function makeDraggable(btn) {
    let pressing = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    function onMove(e) {
      if (!pressing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
      if (moved) applyPosition(btn, origLeft + dx, origTop + dy);
    }

    function onUp() {
      if (!pressing) return;
      pressing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) savePosition(btn);
      else handleSave(); // real click (no drag) -> save
    }

    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      pressing = true;
      moved = false;
      const rect = btn.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  /* -------------------------------------------------------------- setup --- */

  function createButton() {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Save job to tracker';
    btn.setAttribute('aria-label', 'Save job to tracker');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1">' +
      '</path></svg>';

    document.body.appendChild(btn);
    restorePosition(btn);
    makeDraggable(btn);
  }

  window.addEventListener('resize', () => {
    const btn = document.getElementById(BTN_ID);
    if (btn && btn.style.left) {
      applyPosition(btn, parseFloat(btn.style.left), parseFloat(btn.style.top));
    }
  });

  if (document.body) createButton();
  else document.addEventListener('DOMContentLoaded', createButton);
})();
