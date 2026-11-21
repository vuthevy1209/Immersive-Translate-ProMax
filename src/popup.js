const $ = id => document.getElementById(id)
const [[tab], settings] = await Promise.all([
  chrome.tabs.query({ active: true, currentWindow: true }),
  chrome.storage.sync.get({ clickHighlight: true, selectLookup: true, subtitles: true }),
])

async function send(message) {
  const res = await chrome.runtime.sendMessage({ type: 'relay', tabId: tab.id, message })
  if (!res?.ok) throw new Error(res?.error || 'no response')
  return res.result
}

function render({ enabled }) {
  $('toggle').disabled = false
  $('toggle').classList.toggle('on', enabled)
  $('toggle').textContent = enabled ? 'Tắt dịch, hiện bản gốc' : 'Dịch trang này'
}

function showUnsupported() {
  $('toggle').disabled = true
  $('toggle').textContent = 'Không dịch được trang này'
  $('error').textContent = 'Chrome không cho extension chạy trên trang hệ thống (chrome://, Web Store).'
  $('error').hidden = false
}

for (const [id, key] of [['highlight', 'clickHighlight'], ['select', 'selectLookup'], ['subtitles', 'subtitles']]) {
  $(id).checked = settings[key]
  $(id).addEventListener('change', () => chrome.storage.sync.set({ [key]: $(id).checked }))
}
$('toggle').addEventListener('click', async () => render(await send({ type: 'toggle' })))

// Open already showing the page's state instead of flipping to it after appearing. A tab that answers slowly
// (its script is being injected) gets filled in when it does.
const status = send({ type: 'status' })
const first = await Promise.race([
  status.then(value => ({ value }), () => ({ failed: true })),
  new Promise(resolve => setTimeout(() => resolve({}), 400)),
])
if (first.failed) showUnsupported()
else if (first.value) render(first.value)
else status.then(render, showUnsupported)

document.body.classList.remove('loading')
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready'))) // animate only later changes
