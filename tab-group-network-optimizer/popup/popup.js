import {
  FEATURES,
  IDLE_DISCARD_CHOICES,
  TAB_GROUP_ID_NONE,
  formatBytes,
  groupKey,
  normalizeSettings,
  resolveProfile,
} from '../src/rules.js';

// Chrome's tab-group colours.
const GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

const state = {
  settings: normalizeSettings(undefined),
  stats: {},
  groups: [],
  expanded: new Set(), // group keys whose options are open
  notices: new Map(), // group id -> short message
};

/** Tiny DOM builder: h('div', {class: 'x'}, child, 'text'). Text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ------------------------------------------------------------------ data

async function loadGroups() {
  const [win, groups, tabs] = await Promise.all([
    chrome.windows.getCurrent(),
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
  ]);
  const count = new Map();
  for (const t of tabs) {
    if (t.groupId !== TAB_GROUP_ID_NONE) count.set(t.groupId, (count.get(t.groupId) || 0) + 1);
  }
  // Groups of the current window first, then the others, each in tab-strip order.
  const firstIndex = new Map();
  for (const t of tabs) {
    if (t.groupId !== TAB_GROUP_ID_NONE && !firstIndex.has(t.groupId)) firstIndex.set(t.groupId, t.index);
  }
  state.groups = groups
    .map((g) => ({ ...g, key: groupKey(g), tabCount: count.get(g.id) || 0, here: g.windowId === win.id }))
    .sort((a, b) => b.here - a.here || a.windowId - b.windowId || (firstIndex.get(a.id) ?? 0) - (firstIndex.get(b.id) ?? 0));
}

async function loadAll() {
  const [{ settings }, { stats }] = await Promise.all([
    chrome.storage.local.get('settings'),
    chrome.storage.session.get('stats'),
    loadGroups(),
  ]);
  state.settings = normalizeSettings(settings);
  state.stats = stats || {};
}

/** Read-modify-write the settings so two quick clicks never lose a change. */
async function updateSettings(mutate) {
  const { settings } = await chrome.storage.local.get('settings');
  const next = normalizeSettings(settings);
  mutate(next);
  await chrome.storage.local.set({ settings: next });
  state.settings = next;
  render();
}

function setGroupOverride(key, patch) {
  return updateSettings((s) => {
    const current = s.groupProfiles[key];
    const enabled = resolveProfile(s, key).enabled;
    s.groupProfiles[key] = { enabled, ...current, ...patch };
  });
}

// ---------------------------------------------------------------- render

function idleSelect(value, disabled, onChange) {
  return h(
    'label',
    { class: 'idle' },
    h('span', {}, 'Ngủ đông tab không dùng sau'),
    h(
      'select',
      { disabled, onchange: (e) => onChange(Number(e.target.value)) },
      [...new Set([...IDLE_DISCARD_CHOICES, value])].sort((a, b) => a - b).map((m) =>
        h('option', { value: String(m), selected: m === value }, m === 0 ? 'Không bao giờ' : `${m} phút`),
      ),
    ),
  );
}

function featureList(profile, disabled, onChange) {
  return h(
    'div',
    { class: 'features' },
    FEATURES.map((f) =>
      h(
        'label',
        { class: 'feature' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(profile[f.flag]),
          disabled,
          onchange: (e) => onChange({ [f.flag]: e.target.checked }),
        }),
        h('span', {}, f.label),
        h('small', {}, f.hint),
      ),
    ),
    idleSelect(profile.idleDiscardMinutes, disabled, (m) => onChange({ idleDiscardMinutes: m })),
  );
}

function statsLine(key) {
  const s = state.stats[key];
  if (!s) return h('div', { class: 'stats' }, 'Chưa có số liệu — hãy mở hoặc tải lại một tab trong nhóm.');
  return h(
    'div',
    { class: 'stats' },
    'Đã chặn ',
    h('b', {}, s.blocked.toLocaleString('vi-VN')),
    ' · ',
    h('b', {}, s.requests.toLocaleString('vi-VN')),
    ' yêu cầu · ≈ ',
    h('b', {}, formatBytes(s.bytes)),
  );
}

function groupCard(g) {
  const { settings } = state;
  const profile = resolveProfile(settings, g.key);
  const override = settings.groupProfiles[g.key];
  const customised = override && Object.keys(override).some((k) => k !== 'enabled');
  const open = state.expanded.has(g.key);
  const title = g.title?.trim() || 'Nhóm chưa đặt tên';
  const notice = state.notices.get(g.id);

  return h(
    'article',
    { class: `card group${profile.enabled ? '' : ' off'}` },
    h(
      'label',
      { class: 'row switch-row' },
      h(
        'span',
        { class: 'group-title' },
        h('span', { class: 'dot', style: `background:${GROUP_COLORS[g.color] || GROUP_COLORS.grey}` }),
        h('span', { class: 'name', title }, title),
        h('span', { class: 'meta' }, `${g.tabCount} tab${g.here ? '' : ' · cửa sổ khác'}`),
        customised ? h('span', { class: 'tag' }, 'riêng') : null,
      ),
      h('input', {
        type: 'checkbox',
        class: 'switch',
        checked: profile.enabled,
        'aria-label': `Tối ưu nhóm ${title}`,
        onchange: (e) => setGroupOverride(g.key, { enabled: e.target.checked }),
      }),
    ),
    statsLine(g.key),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': String(open),
          onclick: () => {
            open ? state.expanded.delete(g.key) : state.expanded.add(g.key);
            render();
          },
        },
        open ? 'Ẩn tùy chọn ▴' : 'Tùy chỉnh ▾',
      ),
      h(
        'button',
        {
          type: 'button',
          title: 'Đóng kết nối của mọi tab không dùng trong nhóm; bấm vào tab để tải lại.',
          onclick: async () => {
            const res = await chrome.runtime.sendMessage({ type: 'discardGroup', groupId: g.id });
            state.notices.set(g.id, res?.error ? 'Không ngủ đông được.' : `Đã cho ${res.discarded} tab ngủ đông.`);
            render();
            setTimeout(() => {
              state.notices.delete(g.id);
              render();
            }, 2500);
          },
        },
        'Ngủ đông ngay',
      ),
      notice ? h('span', { class: 'notice', role: 'status' }, notice) : null,
    ),
    open
      ? h(
          'div',
          {},
          featureList(profile, !profile.enabled, (patch) => setGroupOverride(g.key, patch)),
          customised
            ? h(
                'div',
                { class: 'actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link',
                    onclick: () =>
                      updateSettings((s) => {
                        delete s.groupProfiles[g.key];
                      }),
                  },
                  'Dùng lại cài đặt mặc định',
                ),
              )
            : null,
          g.title?.trim()
            ? null
            : h('small', { style: 'margin:6px 0 0 18px' }, 'Mẹo: đặt tên cho nhóm để cài đặt được nhớ sau khi mở lại trình duyệt.'),
        )
      : null,
  );
}

function render() {
  const { settings, groups } = state;
  document.getElementById('applyAll').checked = settings.applyToAllGroups;

  const enabledCount = groups.filter((g) => resolveProfile(settings, g.key).enabled).length;
  document.getElementById('groupsHeading').textContent = groups.length
    ? `Nhóm tab · đang tối ưu ${enabledCount}/${groups.length}`
    : 'Nhóm tab';

  const list = document.getElementById('groups');
  list.replaceChildren(
    ...(groups.length
      ? groups.map(groupCard)
      : [
          h(
            'div',
            { class: 'card empty' },
            'Chưa có nhóm tab nào.',
            h('br'),
            'Nhấp chuột phải vào một tab → “Thêm thẻ vào nhóm mới”.',
          ),
        ]),
  );

  document.getElementById('defaults').replaceChildren(
    featureList(settings.defaults, false, (patch) =>
      updateSettings((s) => {
        Object.assign(s.defaults, patch);
      }),
    ),
  );
}

// ------------------------------------------------------------------ wire

document.getElementById('applyAll').addEventListener('change', (e) =>
  updateSettings((s) => {
    s.applyToAllGroups = e.target.checked;
  }),
);

document.getElementById('resetStats').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resetStats' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.stats) {
    state.stats = changes.stats.newValue || {};
    render();
  }
});

let refreshTimer = null;
function refreshGroups() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadGroups();
    render();
  }, 100);
}
chrome.tabGroups.onCreated.addListener(refreshGroups);
chrome.tabGroups.onUpdated.addListener(refreshGroups);
chrome.tabGroups.onRemoved.addListener(refreshGroups);
chrome.tabs.onUpdated.addListener((_id, info) => 'groupId' in info && refreshGroups());
chrome.tabs.onRemoved.addListener(refreshGroups);

loadAll().then(render);
