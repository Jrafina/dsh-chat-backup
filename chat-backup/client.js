/**
 * Client half of `@local/dsh-chat-backup`.
 *
 * One ambient entry below the composer card: the "对话备份" button. It asks the
 * Host half, over the package's own exact route, to render the transcript, pack
 * the latest deliverables, and upload both to R2.
 *
 * The Host refuses a second backup of an unchanged session and reports
 * `needs-confirm` when the session gained prompts since the last one; the
 * confirmation is rendered inline in this entry rather than as an overlay, so
 * it never fights the composer's own layout.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-chat-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/api/chat-backup/run'
    const IDLE_RESET_MS = 6000

    const MESSAGES = {
      idle: '对话备份',
      running: '备份中…',
      done: '已备份到 R2',
      failed: '备份失败 · 重试',
      unconfigured: '备份未配置 · 重试',
    }

    function UploadIcon(props) {
      const color = props.color
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', {
          d: 'M8 1.6 11.4 5l-.95.95L8.7 4.2v5.1H7.3V4.2L5.55 5.95 4.6 5z',
          fill: color,
        }),
        h('path', {
          d: 'M2.6 9.2h1.4v3.1c0 .3.2.5.5.5h7c.3 0 .5-.2.5-.5V9.2h1.4v3.1c0 1.05-.85 1.9-1.9 1.9h-7A1.9 1.9 0 0 1 2.6 12.3z',
          fill: color,
        }),
      )
    }

    /** One compact control, used for both the trigger and the confirmation. */
    function ActionButton(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          onMouseEnter: () => props.onHover?.(true),
          onMouseLeave: () => props.onHover?.(false),
          disabled: props.disabled === true,
          title: props.title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            minHeight: 22,
            border: props.outlined === true
              ? '1px solid var(--dsw-alias-border-l1)'
              : '1px solid transparent',
            borderRadius: 6,
            background: 'transparent',
            color: props.color,
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            cursor: props.disabled === true ? 'progress' : 'pointer',
            opacity: props.disabled === true ? 0.7 : 1,
            whiteSpace: 'nowrap',
            transition: 'color 120ms ease, background-color 120ms ease',
            backgroundColor: props.hovered === true && props.disabled !== true
              ? 'var(--dsw-alias-bg-layer-2)'
              : 'transparent',
          },
        },
        props.children,
      )
    }

    function BackupButton(props) {
      const sessionId = props.sessionId
      const [phase, setPhase] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const [pending, setPending] = React.useState(undefined)
      const [hovered, setHovered] = React.useState('')
      const timer = React.useRef(undefined)

      React.useEffect(
        () => () => {
          if (timer.current !== undefined) clearTimeout(timer.current)
        },
        [],
      )

      // A different session must not inherit the previous session's question.
      const sessionKey = String(sessionId)
      React.useEffect(() => {
        setPhase('idle')
        setDetail('')
        setPending(undefined)
      }, [sessionKey])

      const settle = (next, message) => {
        setPhase(next)
        setDetail(message)
        if (timer.current !== undefined) clearTimeout(timer.current)
        if (next === 'done') {
          timer.current = setTimeout(() => {
            setPhase('idle')
            setDetail('')
          }, IDLE_RESET_MS)
        }
      }

      const send = async (mode) => {
        if (sessionId === undefined) return
        setPhase('running')
        setDetail('')
        setPending(undefined)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId), mode }),
          })
          let payload
          try {
            payload = await response.json()
          } catch {
            payload = undefined
          }
          if (payload?.ok === true) {
            const count = Array.isArray(payload.files) ? payload.files.length : 0
            const extra = Array.isArray(payload.skipped) && payload.skipped.length > 0
              ? `，跳过 ${payload.skipped.length} 个`
              : ''
            const verb = payload.replaced === true ? '已替换旧备份' : '已备份到 R2'
            settle('done', `${verb} · ${payload.folder} · ${count} 个文件${extra}`)
            return
          }
          if (payload?.code === 'needs-confirm' || payload?.code === 'already-backed-up') {
            setPending(payload)
            setPhase('confirm')
            setDetail(payload.message ?? '')
            return
          }
          if (payload?.code === 'not-configured') {
            settle('unconfigured', payload.message ?? 'R2 尚未配置')
            return
          }
          settle('failed', payload?.message ?? `HTTP ${response.status}`)
        } catch (error) {
          settle('failed', String(error?.message ?? error))
        }
      }

      if (sessionId === undefined) return null

      const style = h('style', null, '@keyframes dsh-chat-backup-spin{to{transform:rotate(360deg)}}')

      /* --- the question the Host asked back ----------------------------- */
      if (phase === 'confirm' && pending !== undefined) {
        const replace = pending.code === 'needs-confirm'
        const added = Number(pending.newQuestions ?? 0)
        const headline = replace ? `已备份过 · 追加 ${added} 个提问` : '已备份过 · 无新增提问'
        const primary = replace ? '追加备份' : '重新备份'
        return h(
          React.Fragment,
          null,
          style,
          h(
            'span',
            {
              title: detail,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--dsw-alias-state-warn-primary)',
              },
            },
            h('span', { style: { whiteSpace: 'nowrap' } }, headline),
            h(
              ActionButton,
              {
                outlined: true,
                color: 'var(--dsw-alias-brand-primary)',
                title: replace
                  ? '删除 R2 上的旧备份，用最新的完整对话替换它'
                  : '用当前内容重新生成并覆盖备份',
                hovered: hovered === 'primary',
                onHover: (on) => setHovered(on ? 'primary' : ''),
                onClick: () => send('replace'),
              },
              primary,
            ),
            h(
              ActionButton,
              {
                color: 'var(--dsw-alias-label-secondary)',
                title: '不备份，保留 R2 上的现有内容',
                hovered: hovered === 'cancel',
                onHover: (on) => setHovered(on ? 'cancel' : ''),
                onClick: () => {
                  setPhase('idle')
                  setPending(undefined)
                  setDetail('')
                },
              },
              '取消',
            ),
          ),
        )
      }

      /* --- the ordinary button ------------------------------------------ */
      const color =
        phase === 'failed' || phase === 'unconfigured'
          ? 'var(--dsw-alias-state-error-primary)'
          : phase === 'done'
            ? 'var(--dsw-alias-state-success-primary)'
            : hovered === 'main'
              ? 'var(--dsw-alias-label-primary)'
              : 'var(--dsw-alias-label-secondary)'

      const label = MESSAGES[phase] ?? MESSAGES.idle

      return h(
        React.Fragment,
        null,
        style,
        h(
          ActionButton,
          {
            color,
            disabled: phase === 'running',
            title: detail === '' ? '把这段对话和最近生成的文件打包上传到 R2' : detail,
            hovered: hovered === 'main',
            onHover: (on) => setHovered(on ? 'main' : ''),
            onClick: () => send('auto'),
          },
          phase === 'running'
            ? h('span', {
                'aria-hidden': true,
                style: {
                  display: 'block',
                  width: 10,
                  height: 10,
                  flex: '0 0 auto',
                  borderRadius: '50%',
                  border: '1.5px solid currentColor',
                  borderTopColor: 'transparent',
                  animation: 'dsh-chat-backup-spin 800ms linear infinite',
                },
              })
            : h(UploadIcon, { color }),
          h('span', null, label),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'chat-backup', order: 10 },
            BackupButton,
          ),
        )
      },
    }
  },
})
