/**
 * The primitives the redesigned panel is built from.
 *
 * What is worth asserting here is the accessibility contract and the slider's
 * two-event split, not the class names: the styling is checked in the browser
 * by the production side panel tests.
 */
import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { Card } from '~/entrypoints/sidepanel/ui/Card';
import { Row } from '~/entrypoints/sidepanel/ui/Row';
import { Slider } from '~/entrypoints/sidepanel/ui/Slider';
import { StatusDot } from '~/entrypoints/sidepanel/ui/StatusDot';
import { Switch } from '~/entrypoints/sidepanel/ui/Switch';

describe('Card', () => {
  it('titles itself with a heading', () => {
    render(<Card title="Cache">body</Card>);

    expect(screen.getByRole('heading', { name: 'Cache' }).textContent).toBe('Cache');
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('renders without a title when it holds one control of its own', () => {
    render(<Card>body</Card>);

    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('Row', () => {
  it('shows the label, the help and the control together', () => {
    render(
      <Row label="Volume" help="Only for the current session">
        <span>control</span>
      </Row>
    );

    expect(screen.getByText('Volume')).toBeTruthy();
    expect(screen.getByText('Only for the current session')).toBeTruthy();
    expect(screen.getByText('control')).toBeTruthy();
  });
});

describe('Switch', () => {
  it('is a switch with a state, not a checkbox', () => {
    render(<Switch checked={false} label="Caption window" onChange={() => {}} />);

    const control = screen.getByRole('switch', { name: 'Caption window' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('type')).toBe('button');
  });

  it('reports the on state', () => {
    render(<Switch checked label="Save synthesized audio" onChange={() => {}} />);

    expect(
      screen.getByRole('switch', { name: 'Save synthesized audio' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('asks for the opposite of what it shows', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Caption window" onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing while disabled', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Caption window" onChange={onChange} disabled />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Slider', () => {
  const props = {
    label: 'Volume',
    value: 1,
    min: 0,
    max: 1.5,
    step: 0.05,
    display: '100%',
  };

  it('carries a name and a readable value', () => {
    render(<Slider {...props} onInput={() => {}} onCommit={() => {}} />);

    const slider = screen.getByRole('slider', { name: 'Volume' });
    expect(slider.getAttribute('aria-valuetext')).toBe('100%');
    expect((slider as HTMLInputElement).value).toBe('1');
    expect(slider.getAttribute('max')).toBe('1.5');
  });

  it('reports every move without committing it', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    render(<Slider {...props} onInput={onInput} onCommit={onCommit} />);

    fireEvent.input(screen.getByRole('slider'), { target: { value: '1.25' } });

    expect(onInput).toHaveBeenCalledWith(1.25);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits the value the handle was released on', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    render(<Slider {...props} onInput={onInput} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });

    expect(onCommit).toHaveBeenCalledWith(0);
  });
});

describe('StatusDot', () => {
  it('stays out of the accessible name when the row says the state', () => {
    const { container } = render(<StatusDot state="active" />);

    expect(container.querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('names itself when it stands alone', () => {
    render(<StatusDot state="configured" label="Configured" />);

    expect(screen.getByRole('img', { name: 'Configured' })).toBeTruthy();
  });

  it('carries its state for the stylesheet', () => {
    const { container } = render(<StatusDot state="empty" />);

    expect(container.querySelector('.status-dot')?.getAttribute('data-state')).toBe('empty');
  });
});
