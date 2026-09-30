/**
 * A settings card: one titled block of related rows.
 *
 * The title is an `<h2>` because a card is a section of a tab, never the tab
 * itself — the panel's `<h1>` is the header above it. The title is omitted for
 * a card whose content names itself, like the voice card.
 */
import type { ComponentChildren } from 'preact';

export interface CardProps {
  title?: string;
  children: ComponentChildren;
}

export function Card({ title, children }: CardProps) {
  return (
    <section class="card">
      {title !== undefined && <h2 class="card-title">{title}</h2>}
      <div class="card-body">{children}</div>
    </section>
  );
}
