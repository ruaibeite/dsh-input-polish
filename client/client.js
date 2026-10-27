/**
 * @ruaibeite/dsh-input-polish — browser half.
 *
 * Adds a "polish wording" button to the composer's trailing control cluster
 * (`conversation.input.right`): it renders in the same group as the model
 * selector, to its left. The voice button owns
 * `conversation.input.activity`, a `single` slot, so no second control can sit
 * between it and its neighbours; `conversation.input.right` is the nearest
 * list slot the layout offers.
 *
 * The draft is read from the session input state (`useInput`) and written back
 * with `inputActions.setDraft`, so a rewrite goes through the same undo-able
 * editor path a human edit uses. Drafts holding chips (`@file`, a claimed
 * `/command`) are refused: a whole-draft replacement would drop them.
 *
 * Hand-written, pre-built client bundle — the browser runs it through
 * `window.__ModuleLoader__.load` and supplies React from the module table. It
 * deliberately requires nothing but React: every additional shared module is
 * another way for the entry to fail to materialize.
 */

window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-input-polish',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** Host route served by the plugin's host half. */
    const ROUTE = '/dsh-input-polish/rewrite';

    const zh = navigator.language.toLowerCase().indexOf('zh') === 0;
    const TEXT = zh
      ? {
          action: '优化这段文字',
          busy: '优化中…',
          empty: '先输入一点内容再优化',
          chips: '草稿里有引用或命令，整段替换会丢掉它们',
          submitting: '正在提交，等这一轮结束再优化',
          failed: '优化失败',
        }
      : {
          action: 'Polish this wording',
          busy: 'Polishing…',
          empty: 'Type something first',
          chips: 'The draft holds references or a command; replacing it would drop them',
          submitting: 'Submitting; try again after this turn',
          failed: 'Polish failed',
        };

    /** Button look: a compact icon button that matches the composer's controls. */
    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '4px',
      width: 'auto',
      minWidth: '24px',
      height: '24px',
      padding: '0 4px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '15px',
      lineHeight: '1',
      cursor: 'pointer',
      opacity: '0.75',
    };
    const NOTE_STYLE = { fontSize: '0.8em', opacity: '0.8', maxWidth: '18em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const BUSY_SPIN_STYLE = { display: 'inline-block', animation: 'dsh-input-polish-spin 1s linear infinite' };

    // One keyframes rule per document; the animation is cosmetic, so a failure
    // to install it (e.g. no document) must not break the button.
    try {
      if (document.getElementById('dsh-input-polish-style') === null) {
        const style = document.createElement('style');
        style.id = 'dsh-input-polish-style';
        style.textContent = '@keyframes dsh-input-polish-spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
      }
    } catch {
      /* headless or restricted document: the icon simply does not spin */
    }

    /**
     * Ask the host to rewrite the draft and write the answer back.
     *
     * @param props - standard session-slot props: sessionId, useInput, inputActions.
     */
    function PolishButton(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const useInput = props.useInput;
      const draft = useInput((state) => (state === undefined || state === null ? '' : state.draft ?? ''));
      const phase = useInput((state) => (state === undefined || state === null ? 'plain' : state.phase ?? 'plain'));
      const occurrences = useInput((state) => (state === undefined || state === null ? [] : state.occurrences ?? []));
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);

      React.useEffect(() => {
        setNote(null);
        setBusy(false);
      }, [sessionId]);

      const chips = Array.isArray(occurrences) ? occurrences.length : 0;
      const empty = typeof draft !== 'string' || draft.trim() === '';
      const submitting = phase !== 'plain';
      const reason = empty ? 'empty' : chips > 0 ? 'chips' : submitting ? 'submitting' : '';
      const disabled = busy || reason !== '';

      const onClick = (event) => {
        if (event !== undefined && event !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        if (disabled) return;
        setBusy(true);
        setNote(null);
        Promise.resolve()
          .then(() => fetch(new URL(ROUTE, document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, text: draft }),
          }))
          .then(async (response) => {
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true || typeof payload.text !== 'string') {
              setNote(`${TEXT.failed}: ${(payload !== null && payload.error) || response.status}`);
              return;
            }
            if (payload.text.trim() !== '' && payload.text !== draft && typeof inputActions.setDraft === 'function') {
              inputActions.setDraft(payload.text);
            }
          })
          .catch((error) => {
            setNote(`${TEXT.failed}: ${String((error !== undefined && error !== null && error.message) || error)}`);
          })
          .then(() => {
            setBusy(false);
          });
      };

      const label = busy ? TEXT.busy : reason === '' ? TEXT.action : TEXT[reason];
      const children = [
        React.createElement('span', {
          key: 'icon',
          'aria-hidden': true,
          style: busy ? BUSY_SPIN_STYLE : undefined,
        }, busy ? '↻' : '✨'),
      ];
      if (note !== null) children.push(React.createElement('span', { key: 'note', style: NOTE_STYLE }, note));

      return React.createElement('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        disabled,
        onClick,
        // Keep the composer focused: without this the caret is lost on click.
        onMouseDown: (event) => {
          if (typeof event.preventDefault === 'function') event.preventDefault();
        },
        style: BUTTON_STYLE,
      }, children);
    }

    /** Services this browser half uses. */
    const inject = ['slots'];

    /**
     * Register the button. `conversation.input.right` is declared by
     * client-ui-conversation, so inject() defers until that entry mounts.
     *
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'input-polish',
        order: 900,
      }, PolishButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
