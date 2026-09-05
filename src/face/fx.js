// The face view's FX rack: shared app units plus its stereo flanger, all built
// through the registry's wet/dry scaffold on the island's private
// AudioContext. Only the order and state live here, and the chain re-splices
// when a card is dragged or powered off.

import { buildUnitNodes } from '../fx/registry.js';
import sat from '../fx/units/sat.js';
import pitchtrem from '../fx/units/pitchtrem.js';
import delay from '../fx/units/delay.js';
import reverb from '../fx/units/reverb.js';
import { formatControlValue } from '../core/util.js';
import flanger from './flanger.js';

// The main rack calls this Pitch + Auto Pan. In the face instrument the pitch
// sweep is the headline, so keep the DSP but give its card a more direct name.
const pitchmod = {
  ...pitchtrem,
  label: 'Pitch Modulator',
  params: pitchtrem.params.map((param) => ({
    ...param,
    label:
      { pitch: 'Center', pitchDepth: 'Sweep', rate: 'Rate', depth: 'Pan' }[param.key] ||
      param.label,
  })),
};

export const FACE_FX_UNITS = [sat, flanger, pitchmod, delay, reverb];

// The sliders draw their own fill: --p is the value as a percentage of the
// track, read by the stylesheet's track gradient.
export function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const p = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--p', `${p}%`);
}
const BY_ID = new Map(FACE_FX_UNITS.map((u) => [u.id, u]));

// The captured psychedelic starting patch shown when the view first opens.
export function makeFaceFxState() {
  return {
    order: ['sat', 'delay', 'flanger', 'pitchtrem', 'reverb'],
    states: {
      sat: { ...sat.defaults(), drive: 0.09, mix: 0.61 },
      flanger: flanger.defaults(),
      pitchtrem: {
        ...pitchtrem.defaults(),
        pitch: 0,
        pitchDepth: 1,
        fine: 0,
        rate: 3.45,
        depth: 0,
        shape: 'sine',
        mix: 0.14,
      },
      delay: {
        ...delay.defaults(),
        mode: 'stereo',
        time: 0.38,
        feedback: 0.72,
        hp: 990,
        mix: 0.71,
      },
      reverb: {
        ...reverb.defaults(),
        size: 3.7,
        decay: 6.6,
        predelay: 0.025,
        damping: 0.45,
        mix: 0.75,
      },
    },
  };
}

export function createFaceFxRack(ctx, out, fx) {
  const input = ctx.createGain();
  const nodes = {};
  FACE_FX_UNITS.forEach((u) => {
    nodes[u.id] = buildUnitNodes(u, ctx, fx.states[u.id], (key) => fx.states[u.id][key]);
  });

  // What a unit's apply/applyAll expect alongside the nodes.
  const unitArgs = (id) => {
    const state = fx.states[id];
    return { ac: ctx, state };
  };
  const applyParam = (id, key, val) => {
    const n = nodes[id];
    if (key === 'mix') {
      // The scaffold owns the crossfade, exactly as the main rack does.
      n.wet.gain.value = val;
      n.dry.gain.value = 1 - val;
      return;
    }
    BY_ID.get(id).apply?.(n, key, val, unitArgs(id));
  };
  const applyUnit = (id) => {
    const u = BY_ID.get(id);
    u.params.forEach(({ key }) => applyParam(id, key, fx.states[id][key]));
    u.applyAll?.(nodes[id], unitArgs(id));
  };
  FACE_FX_UNITS.forEach((u) => applyUnit(u.id));

  function reconnect() {
    input.disconnect();
    FACE_FX_UNITS.forEach((u) => nodes[u.id].out.disconnect());
    let prev = input;
    fx.order.forEach((id) => {
      if (fx.states[id].enabled === false) return;
      prev.connect(nodes[id].in);
      prev = nodes[id].out;
    });
    prev.connect(out);
  }
  reconnect();

  return {
    input,
    setParam(id, key, val) {
      fx.states[id][key] = val;
      applyParam(id, key, val);
    },
    setMode(id, key, val) {
      fx.states[id][key] = val;
      BY_ID.get(id).applyAll?.(nodes[id], unitArgs(id));
    },
    setEnabled(id, on) {
      fx.states[id].enabled = on;
      reconnect();
    },
    setOrder(order) {
      fx.order = order;
      reconnect();
    },
    dispose() {
      try {
        input.disconnect();
      } catch (e) {}
      Object.values(nodes).forEach((n) => {
        try {
          n.out.disconnect();
        } catch (e) {}
      });
    },
  };
}

// The cards. They edit `fx` directly and push to whatever rack getRack()
// returns, so the panel works before audio starts and the state survives a
// stop/start. Drag a card by its grip to reorder; the chain follows.
export function buildFaceFxPanel(fx, host, getRack) {
  const strip = document.createElement('div');
  strip.className = 'face-fx';
  const cards = new Map(FACE_FX_UNITS.map((u) => [u.id, buildCard(u)]));
  fx.order.forEach((id) => strip.appendChild(cards.get(id)));

  strip.addEventListener('dragover', (e) => {
    const dragging = strip.querySelector('.face-fx-card.dragging');
    if (!dragging) return;
    e.preventDefault();
    const after = [...strip.querySelectorAll('.face-fx-card:not(.dragging)')].find(
      (c) => e.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2,
    );
    if (after) strip.insertBefore(dragging, after);
    else strip.appendChild(dragging);
  });
  strip.addEventListener('drop', (e) => e.preventDefault());
  host.appendChild(strip);

  function commitOrder() {
    const order = [...strip.querySelectorAll('.face-fx-card')].map((c) => c.dataset.id);
    if (order.join() === fx.order.join()) return;
    fx.order = order;
    getRack()?.setOrder(order);
  }

  function buildCard(u) {
    const st = fx.states[u.id];
    const card = document.createElement('div');
    card.className = 'face-fx-card' + (st.enabled === false ? ' off' : '');
    card.dataset.id = u.id;

    const head = document.createElement('div');
    head.className = 'face-fx-head';
    const grip = document.createElement('span');
    grip.className = 'face-fx-grip';
    grip.textContent = '●●●';
    grip.title = 'Drag to reorder';
    const label = document.createElement('span');
    label.className = 'face-fx-label';
    label.textContent = u.label;
    const power = document.createElement('button');
    power.type = 'button';
    power.className = 'face-fx-power' + (st.enabled === false ? '' : ' active');
    power.textContent = '⏻';
    power.title = 'Power';
    power.addEventListener('click', () => {
      st.enabled = st.enabled === false;
      power.classList.toggle('active', st.enabled);
      card.classList.toggle('off', !st.enabled);
      getRack()?.setEnabled(u.id, st.enabled);
    });
    head.append(grip, label, power);
    card.appendChild(head);

    // Only the grip starts a drag, so the sliders stay sliders.
    grip.addEventListener('pointerdown', () => (card.draggable = true));
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', u.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
      commitOrder();
    });
    window.addEventListener('pointerup', () => (card.draggable = false));

    (u.modeRows || []).forEach((row) => {
      const modes = document.createElement('div');
      modes.className = 'face-fx-modes';
      const btns = row.options.map(([value, text]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'face-fx-mode' + (st[row.key] === value ? ' active' : '');
        b.textContent = text;
        b.addEventListener('click', () => {
          st[row.key] = value;
          btns.forEach((x, i) => x.classList.toggle('active', row.options[i][0] === value));
          getRack()?.setMode(u.id, row.key, value);
        });
        modes.appendChild(b);
        return b;
      });
      card.appendChild(modes);
    });

    u.params.forEach((pd) => {
      const row = document.createElement('label');
      row.className = 'face-fx-param';
      const name = document.createElement('span');
      name.textContent = pd.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(pd.min);
      input.max = String(pd.max);
      input.step = String(pd.step);
      input.value = String(st[pd.key]);
      paintRange(input);
      const val = document.createElement('span');
      val.className = 'face-fx-val';
      val.textContent = formatControlValue(pd, st[pd.key]);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        st[pd.key] = v;
        paintRange(input);
        val.textContent = formatControlValue(pd, v);
        getRack()?.setParam(u.id, pd.key, v);
      });
      row.append(name, input, val);
      card.appendChild(row);
    });
    return card;
  }
}
