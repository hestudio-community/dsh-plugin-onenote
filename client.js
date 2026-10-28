/**
 * Browser half of `dsh-plugin-onenote`: the settings card.
 *
 * This is the ONLY surface where a person can sign in or change which notebooks
 * are readable. The agent tools are read-only, so the allow-list is a real
 * boundary: a page that tries to talk the model into reading another notebook
 * has nothing to call.
 *
 * The card is hand-written as a `__ModuleLoader__` bundle (no build step). It
 * talks to the Host over the plugin's own `/api/onenote/*` routes and uses only
 * host theme tokens for styling, so it follows light/dark automatically.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-onenote',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/onenote'
    /** The card re-polls while a device code is outstanding; the Host never blocks. */
    const POLL_MS = 3000
    const NS = 'onenote'

    const en = {
      'title': 'OneNote',
      'summary': 'Sign in to Microsoft OneNote and choose which notebooks this agent may read.',
      'loading': 'Loading…',
      'error': 'Something went wrong',
      'retry': 'Try again',
      'clientId': 'Azure application (client) ID',
      'clientId.hint': 'Set clientId and tenant in cordis.patch.yml to use your own app registration.',
      'signedOut.title': 'Not connected',
      'signedOut.body': 'Sign in with a Microsoft account that can open the notebooks you want this agent to read. Nothing is readable until you also choose notebooks below.',
      'signIn': 'Sign in with Microsoft',
      'signIn.busy': 'Starting…',
      'pending.title': 'Enter this code',
      'pending.body': 'Open the sign-in page and enter the code below. This panel finishes on its own once you approve.',
      'pending.open': 'Open sign-in page',
      'pending.expires': 'Expires in {seconds}s',
      'pending.expired': 'That code expired. Start sign-in again for a fresh one.',
      'pending.copy': 'Copy code',
      'pending.copied': 'Copied',
      'signedIn.title': 'Connected',
      'signedIn.as': 'Signed in as {name}',
      'signedIn.account': 'Signed in',
      'signedIn.renews': 'Access renews automatically.',
      'signOut': 'Sign out',
      'notebooks.title': 'Readable notebooks',
      'notebooks.body': 'Only the notebooks you tick can be listed, searched, or read. Every other notebook stays invisible to the agent.',
      'notebooks.empty': 'No notebooks are allowed, so the agent can read nothing right now.',
      'notebooks.none': 'This account has no notebooks.',
      'notebooks.refresh': 'Refresh list',
      'notebooks.shared': 'shared',
      'notebooks.default': 'default',
      'notebooks.count': '{count} of {total} allowed',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved. {count} notebook(s) are now readable.',
      'clear': 'Allow none',
      'cleared': 'Cleared. Nothing is readable now.',
      'loadFailed': 'Could not load the notebook list: {error}',
      'signInFailed': 'Sign-in failed: {error}',
      'saveFailed': 'Could not save: {error}',
      'settingsPath': 'Settings → Plugins → OneNote',
      'unreachable': 'The plugin routes are not registered in this process. Restart DeepSeek Harness, then reopen this card.'
    }

    const zh = {
      'title': 'OneNote',
      'summary': '登录 Microsoft OneNote，并选择允许本助手读取哪些笔记本。',
      'loading': '加载中…',
      'error': '出了点问题',
      'retry': '重试',
      'clientId': 'Azure 应用（客户端）ID',
      'clientId.hint': '如需使用自己的应用注册，请在 cordis.patch.yml 中设置 clientId 与 tenant。',
      'signedOut.title': '未连接',
      'signedOut.body': '请用能够打开目标笔记本的 Microsoft 账户登录。在下方勾选笔记本之前，助手读不到任何内容。',
      'signIn': '使用 Microsoft 登录',
      'signIn.busy': '正在启动…',
      'pending.title': '请输入此代码',
      'pending.body': '打开登录页面并输入下方代码。你确认后本面板会自动完成。',
      'pending.open': '打开登录页面',
      'pending.expires': '{seconds} 秒后过期',
      'pending.expired': '代码已过期，请重新开始登录。',
      'pending.copy': '复制代码',
      'pending.copied': '已复制',
      'signedIn.title': '已连接',
      'signedIn.as': '已登录：{name}',
      'signedIn.account': '已登录',
      'signedIn.renews': '访问令牌会自动续期。',
      'signOut': '退出登录',
      'notebooks.title': '可读笔记本',
      'notebooks.body': '只有勾选的笔记本可以被列出、搜索和读取，其余笔记本对助手完全不可见。',
      'notebooks.empty': '当前没有授权任何笔记本，助手暂时读不到内容。',
      'notebooks.none': '该账户下没有笔记本。',
      'notebooks.refresh': '刷新列表',
      'notebooks.shared': '共享',
      'notebooks.default': '默认',
      'notebooks.count': '已授权 {count} / {total}',
      'save': '保存',
      'saving': '保存中…',
      'saved': '已保存，当前可读 {count} 个笔记本。',
      'clear': '全部取消',
      'cleared': '已清空，当前不可读取任何笔记本。',
      'loadFailed': '无法加载笔记本列表：{error}',
      'signInFailed': '登录失败：{error}',
      'saveFailed': '保存失败：{error}',
      'settingsPath': '设置 → 插件 → OneNote',
      'unreachable': '本进程没有注册插件路由。请重启 DeepSeek Harness，然后重新打开本卡片。'
    }

    const CSS = [
      '.dsh-onenote{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary)}',
      '.dsh-onenote-h{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.dsh-onenote-p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-onenote-muted{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-onenote-box{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}',
      '.dsh-onenote-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-onenote-spread{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dsh-onenote-btn{height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 12px;font-size:13px;cursor:pointer}',
      '.dsh-onenote-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}',
      '.dsh-onenote-btn:disabled{opacity:.5;cursor:default}',
      // The primary button must pair the host's own fill and label tokens.
      // `brand-primary` inverts between themes (near-black on light, near-white
      // on dark), so using it as a fill with a literal white label produced
      // white-on-white and an unreadable sign-in button in dark mode.
      '.dsh-onenote-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-onenote-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
      '.dsh-onenote-code{font-family:var(--ds-font-family-code,monospace);font-size:26px;letter-spacing:4px;font-weight:600;padding:10px 14px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);align-self:flex-start}',
      '.dsh-onenote-link{color:var(--dsw-alias-link);font-size:13px;text-decoration:none;word-break:break-all}',
      '.dsh-onenote-link:hover{text-decoration:underline}',
      '.dsh-onenote-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto}',
      '.dsh-onenote-item{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px}',
      '.dsh-onenote-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-onenote-item input{margin:0;width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsh-onenote-name{font-size:13px;line-height:20px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-onenote-tag{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-onenote-warn{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:20px;border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}',
      '.dsh-onenote-err{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);margin:0}',
      '.dsh-onenote-ok{font-size:13px;line-height:20px;color:var(--dsw-alias-state-success-primary);margin:0}',
      '.dsh-onenote-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}'
    ].join('\n')

    /** Translate with `{name}` interpolation, falling back to the key itself. */
    function makeT(dict, fallbackDict) {
      return (key, params) => {
        const raw = dict[key] !== undefined ? dict[key] : (fallbackDict[key] !== undefined ? fallbackDict[key] : key)
        if (params === undefined) return raw
        return raw.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    }

    /**
     * One fetch wrapper: every route answers JSON, and a network fault becomes data.
     *
     * A non-JSON body is reported with its status and a first line of text,
     * never as a bare "unreadable response": the usual cause is that the Host
     * never registered `/api/onenote/*`, so the request fell through to the
     * Web server's own `/api` prefix and got its plain-text 401. Naming that
     * tells the user to restart, which is the only thing that helps.
     */
    async function call(path, init) {
      let response
      try {
        response = await fetch(API + path, Object.assign({ cache: 'no-store' }, init || {}))
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
      const text = await response.text().catch(() => '')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        const detail = text.trim().split('\n', 1)[0].slice(0, 120)
        return {
          ok: false,
          error: 'HTTP ' + response.status + (detail.length > 0 ? ': ' + detail : ''),
          unreachable: true
        }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'The server answered with a non-object JSON value.', unreachable: true }
      }
      return parsed
    }

    function Spinner() {
      return h('span', {
        'aria-hidden': true,
        style: {
          width: 12, height: 12, borderRadius: '50%',
          border: '2px solid var(--dsw-alias-border-l2)',
          borderTopColor: 'var(--dsw-alias-brand-primary)',
          display: 'inline-block', animation: 'dsh-onenote-spin 0.9s linear infinite'
        }
      })
    }

    function OneNoteCard(props) {
      const { t: hostT, view } = props
      const t = React.useMemo(() => makeT(zh, en), [])
      // Prefer the host locale binding when the page supplies one.
      const tr = React.useCallback((key, params) => {
        if (typeof hostT === 'function') {
          const translated = hostT(NS + '.' + key, params)
          if (translated !== NS + '.' + key && translated !== key) return translated
        }
        return t(key, params)
      }, [hostT, t])

      const [state, setState] = React.useState({ phase: 'loading' })
      const [pending, setPending] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => () => { alive.current = false }, [])

      const applyState = React.useCallback((next) => {
        if (!alive.current) return
        if (next === null || next === undefined || next.ok !== true) {
          setError(next && next.error ? next.error : 'Unknown error')
          // A non-JSON answer means the Host half never mounted its routes, so
          // "Try again" cannot help; the card offers the restart instead.
          setState({ phase: 'error', unreachable: next !== null && next !== undefined && next.unreachable === true })
          return
        }
        setError(null)
        const notebooks = Array.isArray(next.notebooks) ? next.notebooks : []
        setState({
          phase: 'ready',
          signedIn: next.signedIn === true,
          account: next.account,
          expiresAt: next.expiresAt,
          allowedCount: typeof next.allowedCount === 'number' ? next.allowedCount : 0,
          notebooks,
          notebooksError: next.notebooksError
        })
        setSelected(notebooks.filter((nb) => nb.allowed === true).map((nb) => nb.id))
      }, [])

      const load = React.useCallback(async () => {
        const next = await call('/state')
        applyState(next)
      }, [applyState])

      React.useEffect(() => { load() }, [load])

      // While a device code is outstanding, poll once every few seconds. The Host
      // answers immediately, so this never holds a request open.
      React.useEffect(() => {
        if (pending === null) return undefined
        let cancelled = false
        const timer = setInterval(async () => {
          const next = await call('/device-code')
          if (cancelled || !alive.current) return
          if (next.ok !== true) {
            setPending(null)
            setError(next.error || 'Sign-in failed')
            return
          }
          if (next.status === 'signed-in') {
            setPending(null)
            setNotice(tr('signedIn.title'))
            applyState(next)
            return
          }
          if (next.status === 'expired') {
            setPending(null)
            setError(tr('pending.expired'))
            return
          }
          setPending((current) => current === null ? current : Object.assign({}, current, {
            expiresInSeconds: next.expiresInSeconds
          }))
        }, POLL_MS)
        return () => { cancelled = true; clearInterval(timer) }
      }, [pending, applyState, tr])

      const startSignIn = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        const next = await call('/device-code/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        if (!alive.current) return
        setBusy(false)
        if (next.ok !== true) {
          setError(tr('signInFailed', { error: next.error || 'unknown' }))
          return
        }
        setPending({
          userCode: next.userCode,
          verificationUri: next.verificationUri,
          expiresInSeconds: next.expiresInSeconds
        })
      }

      const doSignOut = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        await call('/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        setPending(null)
        setBusy(false)
        await load()
      }

      const save = async () => {
        if (selected === null) return
        setBusy(true)
        setError(null)
        setNotice(null)
        const next = await call('/notebooks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowedIds: selected })
        })
        if (!alive.current) return
        setBusy(false)
        if (next.ok !== true) {
          setError(tr('saveFailed', { error: next.error || 'unknown' }))
          return
        }
        setNotice(tr('saved', { count: selected.length }))
        applyState(next)
      }

      const clearAll = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        const next = await call('/notebooks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'clear' })
        })
        if (!alive.current) return
        setBusy(false)
        if (next.ok !== true) {
          setError(tr('saveFailed', { error: next.error || 'unknown' }))
          return
        }
        setNotice(tr('cleared'))
        applyState(next)
      }

      const copyCode = async () => {
        if (pending === null) return
        try {
          await navigator.clipboard.writeText(pending.userCode)
          setCopied(true)
          setTimeout(() => { if (alive.current) setCopied(false) }, 1600)
        } catch {
          setCopied(false)
        }
      }

      const toggle = (id) => {
        setSelected((current) => {
          const base = Array.isArray(current) ? current.slice() : []
          const at = base.indexOf(id)
          if (at >= 0) base.splice(at, 1)
          else base.push(id)
          return base
        })
        setNotice(null)
      }

      // The Plugins page draws the title, icon, and breadcrumb, so the summary
      // view returns the one-line description and the page view returns the form.
      if (view === 'summary') return tr('summary')

      const style = h('style', { key: 'style' }, CSS + '\n@keyframes dsh-onenote-spin{to{transform:rotate(360deg)}}')

      if (state.phase === 'loading') {
        return h('div', { className: 'dsh-onenote' },
          style,
          h('p', { className: 'dsh-onenote-p' }, tr('loading'))
        )
      }

      if (state.phase === 'error') {
        return h('div', { className: 'dsh-onenote' },
          style,
          h('p', { className: 'dsh-onenote-err' }, tr('error') + ': ' + (error || '')),
          state.unreachable === true
            ? h('p', { className: 'dsh-onenote-warn' }, tr('unreachable'))
            : null,
          h('div', { className: 'dsh-onenote-row' },
            h('button', { type: 'button', className: 'dsh-onenote-btn', onClick: () => { setState({ phase: 'loading' }); load() } }, tr('retry'))
          )
        )
      }

      const children = [style]

      if (pending !== null) {
        children.push(h('div', { className: 'dsh-onenote-box', key: 'pending' },
          h('h3', { className: 'dsh-onenote-h' }, tr('pending.title')),
          h('p', { className: 'dsh-onenote-p' }, tr('pending.body')),
          h('div', { className: 'dsh-onenote-code' }, pending.userCode || '—'),
          h('div', { className: 'dsh-onenote-row' },
            h('a', {
              className: 'dsh-onenote-link',
              href: pending.verificationUri || 'https://microsoft.com/devicelogin',
              target: '_blank',
              rel: 'noreferrer noopener'
            }, tr('pending.open')),
            h('button', { type: 'button', className: 'dsh-onenote-btn', onClick: copyCode }, copied ? tr('pending.copied') : tr('pending.copy')),
            h('span', { className: 'dsh-onenote-caption' }, tr('pending.expires', { seconds: pending.expiresInSeconds }))
          )
        ))
      }

      if (!state.signedIn && pending === null) {
        children.push(h('div', { className: 'dsh-onenote-box', key: 'signed-out' },
          h('h3', { className: 'dsh-onenote-h' }, tr('signedOut.title')),
          h('p', { className: 'dsh-onenote-p' }, tr('signedOut.body')),
          h('div', { className: 'dsh-onenote-row' },
            h('button', {
              type: 'button',
              className: 'dsh-onenote-btn dsh-onenote-btn-primary',
              disabled: busy,
              onClick: startSignIn
            }, busy ? tr('signIn.busy') : tr('signIn'))
          )
        ))
      }

      if (state.signedIn) {
        const who = state.account && (state.account.displayName || state.account.userPrincipalName)
        children.push(h('div', { className: 'dsh-onenote-box', key: 'signed-in' },
          h('div', { className: 'dsh-onenote-spread' },
            h('div', null,
              h('h3', { className: 'dsh-onenote-h' }, tr('signedIn.title')),
              h('p', { className: 'dsh-onenote-p' }, who ? tr('signedIn.as', { name: who }) : tr('signedIn.account')),
              h('p', { className: 'dsh-onenote-muted' }, tr('signedIn.renews'))
            ),
            h('button', { type: 'button', className: 'dsh-onenote-btn', disabled: busy, onClick: doSignOut }, tr('signOut'))
          )
        ))

        const notebooks = state.notebooks
        const rows = notebooks.map((notebook) => {
          const checked = Array.isArray(selected) && selected.indexOf(notebook.id) >= 0
          return h('li', { key: notebook.id, className: 'dsh-onenote-item' },
            h('input', {
              type: 'checkbox',
              checked,
              id: 'dsh-onenote-nb-' + notebook.id,
              onChange: () => toggle(notebook.id)
            }),
            h('label', { className: 'dsh-onenote-name', htmlFor: 'dsh-onenote-nb-' + notebook.id, title: notebook.name }, notebook.name),
            notebook.isShared ? h('span', { className: 'dsh-onenote-tag' }, tr('notebooks.shared')) : null,
            notebook.isDefault ? h('span', { className: 'dsh-onenote-tag' }, tr('notebooks.default')) : null
          )
        })

        children.push(h('div', { className: 'dsh-onenote-box', key: 'notebooks' },
          h('div', { className: 'dsh-onenote-spread' },
            h('div', null,
              h('h3', { className: 'dsh-onenote-h' }, tr('notebooks.title')),
              h('p', { className: 'dsh-onenote-p' }, tr('notebooks.body'))
            ),
            h('button', { type: 'button', className: 'dsh-onenote-btn', disabled: busy, onClick: load }, tr('notebooks.refresh'))
          ),
          state.notebooksError
            ? h('p', { className: 'dsh-onenote-err' }, tr('loadFailed', { error: state.notebooksError }))
            : null,
          state.allowedCount === 0
            ? h('div', { className: 'dsh-onenote-warn' }, tr('notebooks.empty'))
            : null,
          notebooks.length === 0
            ? h('p', { className: 'dsh-onenote-muted' }, tr('notebooks.none'))
            : h('ul', { className: 'dsh-onenote-list' }, rows),
          h('div', { className: 'dsh-onenote-spread' },
            h('span', { className: 'dsh-onenote-caption' }, tr('notebooks.count', {
              count: Array.isArray(selected) ? selected.length : 0,
              total: notebooks.length
            })),
            h('div', { className: 'dsh-onenote-row' },
              h('button', { type: 'button', className: 'dsh-onenote-btn', disabled: busy, onClick: clearAll }, tr('clear')),
              h('button', {
                type: 'button',
                className: 'dsh-onenote-btn dsh-onenote-btn-primary',
                disabled: busy || notebooks.length === 0,
                onClick: save
              }, busy ? tr('saving') : tr('save'))
            )
          )
        ))
      }

      if (notice !== null) children.push(h('p', { className: 'dsh-onenote-ok', key: 'notice' }, notice))
      if (error !== null) children.push(h('p', { className: 'dsh-onenote-err', key: 'error' }, error))
      if (busy) children.push(h('div', { className: 'dsh-onenote-row', key: 'busy' }, h(Spinner, null)))

      return h('div', { className: 'dsh-onenote' }, children)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        // Keyed by the bundle's package name: the Plugins page dispatches this
        // entry on the dsh-plugin-onenote bundle page.
        key: 'dsh-plugin-onenote',
        id: 'dsh-plugin-onenote',
        locale: NS
      }, OneNoteCard))
    }

    return { inject: ['slots', 'locale'], apply }
  }
})
