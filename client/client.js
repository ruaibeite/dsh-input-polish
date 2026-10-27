/**
 * @ruaibeite/dsh-input-polish — browser half.
 *
 * Adds a "polish wording" button to the composer's trailing control cluster
 * (`conversation.input.right`): it sits left of the model selector, i.e. in the
 * same group as — and immediately left of — the voice button on hosts where the
 * model selector is hidden. The composer's voice input owns
 * `conversation.input.activity`, which is a `single` slot, so a second control
 * cannot sit between it and its neighbours; `conversation.input.right` is the
 * nearest list slot the layout offers.
 *
 * The draft is read from the session input state and written back with
 * `inputActions.setDraft`, so the rewrite goes through the same undo-able editor
 * path a human edit uses. Chips (`@file`, claimed `/command`) are rejected: a
 * whole-draft replacement would drop them.
 *
 * This file is a hand-written, pre-built client bundle: the browser executes it
 * through `window.__ModuleLoader__.load`, and the host supplies React and the
 * official primitives through the module table.
 */

window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-input-polish',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx } = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const Button = primitives.Button;
    const Tooltip = primitives.Tooltip;
    const Sparkle = primitives.IconSparkleRegular;
    const Spinner = primitives.IconLoadingOutlineRegular;

    const NS = 'input-polish';
    const zh = {
      action: '优化这段文字',
      busy: '优化中…',
      empty: '先输入一点内容再优化',
      'blocked.chips': '草稿里有引用或命令，整段替换会丢掉它们',
      'blocked.busy': '正在提交，等这一轮结束再优化',
      failed: '优化失败',
    };
    const en = {
      action: 'Polish this wording',
      busy: 'Polishing…',
      empty: 'Type something first',
      'blocked.chips': 'The draft holds references or a command; replacing it would drop them',
      'blocked.busy': 'Submitting; try again after this turn',
      failed: 'Polish failed',
    };

    /** Host route served by the plugin's host half. */
    const ROUTE = '/dsh-input-polish/rewrite';

    const NOTE_STYLE = { fontSize: '0.85em', opacity: '0.85', maxWidth: '20em' };

    /**
     * Ask the host to rewrite the draft and write the answer back.
     *
     * @param props - standard session slot props.
     */
    function PolishButton({ sessionId, inputActions, useInput, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const draft = useInput((state) => state?.draft ?? '');
      const phase = useInput((state) => state?.phase ?? 'plain');
      const occurrences = useInput((state) => state?.occurrences ?? []);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);

      React.useEffect(() => {
        setNote(null);
        setBusy(false);
      }, [sessionId]);

      const chips = Array.isArray(occurrences) ? occurrences.length : 0;
      const empty = draft.trim() === '';
      const busyPhase = phase !== 'plain';
      const reason = empty ? 'empty' : chips > 0 ? 'blocked.chips' : busyPhase ? 'blocked.busy' : '';
      const disabled = busy || reason !== '';

      const onClick = async (event) => {
        if (event !== undefined && event !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        if (disabled) return;
        setBusy(true);
        setNote(null);
        try {
          const response = await fetch(new URL(ROUTE, document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, text: draft }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || payload === null || payload.ok !== true || typeof payload.text !== 'string') {
            setNote(`${tr('failed')}: ${payload?.error ?? response.status}`);
            return;
          }
          if (payload.text.trim() !== '' && payload.text !== draft && typeof inputActions?.setDraft === 'function') {
            inputActions.setDraft(payload.text);
          }
        } catch (error) {
          setNote(`${tr('failed')}: ${String(error?.message ?? error)}`);
        } finally {
          setBusy(false);
        }
      };

      const label = busy ? tr('busy') : reason === '' ? tr('action') : tr(reason);
      const children = [
        busy
          ? jsx(Spinner, { key: 'icon', size: 16 })
          : jsx(Sparkle, { key: 'icon', size: 16 }),
      ];
      if (note !== null) children.push(jsx('span', { key: 'note', style: NOTE_STYLE }, note));

      return jsx(Tooltip, {
        label,
        side: 'top',
        delayMs: 500,
        disabled: busy,
        children: jsx(Button, {
          type: 'button',
          size: 'sm',
          variant: 'ghost',
          'aria-label': label,
          disabled,
          // Keep the composer focused: without this the caret is lost on click.
          onMouseDown: (event) => {
            if (typeof event.preventDefault === 'function') event.preventDefault();
          },
          onClick,
          children,
        }),
      });
    }

    /** Services this browser half uses. */
    const inject = ['slots', 'locale'];

    /**
     * Register the button. `conversation.input.right` is declared by
     * client-ui-conversation, so inject() defers until that entry mounts.
     *
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'input-polish: dictionaries');
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'input-polish',
        order: 900,
        locale: NS,
      }, PolishButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
