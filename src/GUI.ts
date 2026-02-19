// ---------------------------------------------------------------------------
// Real-time Parameter GUI
//
// Expandable card panels with range sliders for tweaking terrain, atmosphere,
// clouds, ocean, lighting, and camera parameters in real time.
// ---------------------------------------------------------------------------

export interface SliderDef {
  label: string;
  key: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}

export interface ColorDef {
  label: string;
  key: string;
  r: number;
  g: number;
  b: number;
  onChange: (r: number, g: number, b: number) => void;
}

export interface CardDef {
  title: string;
  icon: string;
  sliders?: SliderDef[];
  colors?: ColorDef[];
}

export class GUI {
  private container: HTMLDivElement;
  private toggle: HTMLButtonElement;
  private panelVisible = false;
  private cards: Map<string, HTMLDivElement> = new Map();
  private sliderInputs: Map<string, HTMLInputElement> = new Map();
  private valueLabels: Map<string, HTMLSpanElement> = new Map();

  constructor() {
    // Toggle button
    this.toggle = document.createElement('button');
    this.toggle.id = 'gui-toggle';
    this.toggle.textContent = 'Settings';
    this.toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.panelVisible = !this.panelVisible;
      this.container.style.display = this.panelVisible ? 'block' : 'none';
      this.toggle.classList.toggle('active', this.panelVisible);
    });
    // Prevent pointer lock when interacting with the toggle
    this.toggle.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.toggle);

    // Panel container
    this.container = document.createElement('div');
    this.container.id = 'gui-panel';
    this.container.style.display = 'none';
    // Prevent pointer lock when interacting with the panel
    this.container.addEventListener('click', (e) => e.stopPropagation());
    this.container.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.container);
  }

  addCard(def: CardDef): void {
    const card = document.createElement('div');
    card.className = 'gui-card';

    // Header (clickable to expand/collapse)
    const header = document.createElement('div');
    header.className = 'gui-card-header';
    header.innerHTML = `<span class="gui-card-icon">${def.icon}</span><span class="gui-card-title">${def.title}</span><span class="gui-card-arrow">&#9660;</span>`;
    card.appendChild(header);

    // Body (collapsible)
    const body = document.createElement('div');
    body.className = 'gui-card-body';
    body.style.display = 'none';

    // Sliders
    if (def.sliders) {
      for (const s of def.sliders) {
        const row = document.createElement('div');
        row.className = 'gui-row';

        const label = document.createElement('label');
        label.className = 'gui-label';
        label.textContent = s.label;

        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'gui-slider';
        input.min = String(s.min);
        input.max = String(s.max);
        input.step = String(s.step);
        input.value = String(s.value);

        const valSpan = document.createElement('span');
        valSpan.className = 'gui-value';
        valSpan.textContent = this.formatValue(s.value, s.step);

        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          valSpan.textContent = this.formatValue(v, s.step);
          s.onChange(v);
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(valSpan);
        body.appendChild(row);

        this.sliderInputs.set(s.key, input);
        this.valueLabels.set(s.key, valSpan);
      }
    }

    // Color pickers
    if (def.colors) {
      for (const c of def.colors) {
        const row = document.createElement('div');
        row.className = 'gui-row gui-color-row';

        const label = document.createElement('label');
        label.className = 'gui-label';
        label.textContent = c.label;

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'gui-color';
        colorInput.value = this.rgbToHex(c.r, c.g, c.b);

        colorInput.addEventListener('input', () => {
          const hex = colorInput.value;
          const r = parseInt(hex.slice(1, 3), 16) / 255;
          const g = parseInt(hex.slice(3, 5), 16) / 255;
          const b = parseInt(hex.slice(5, 7), 16) / 255;
          c.onChange(r, g, b);
        });

        row.appendChild(label);
        row.appendChild(colorInput);
        body.appendChild(row);
      }
    }

    card.appendChild(body);

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      card.classList.toggle('open', !isOpen);
    });

    this.container.appendChild(card);
    this.cards.set(def.title, card);
  }

  /** Update a slider's value programmatically */
  setValue(key: string, value: number): void {
    const input = this.sliderInputs.get(key);
    const label = this.valueLabels.get(key);
    if (input) {
      input.value = String(value);
      if (label) {
        label.textContent = this.formatValue(value, parseFloat(input.step));
      }
    }
  }

  private formatValue(v: number, step: number): string {
    if (step >= 1) return v.toFixed(0);
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    return v.toFixed(Math.min(decimals, 6));
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (c: number) => {
      const h = Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
}
