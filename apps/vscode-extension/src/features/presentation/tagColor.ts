import * as vscode from 'vscode';

import type { TagColor, TagSummary } from '../../types';

export const TAG_COLOR_MARKERS: Record<TagColor, string> = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  green: '🟢',
  blue: '🔵',
  purple: '🟣',
};

export const TAG_COLOR_OPTIONS: ReadonlyArray<{ label: string; color: TagColor }> = [
  { label: 'Red', color: 'red' },
  { label: 'Orange', color: 'orange' },
  { label: 'Yellow', color: 'yellow' },
  { label: 'Green', color: 'green' },
  { label: 'Blue', color: 'blue' },
  { label: 'Purple', color: 'purple' },
];

export function tagColorMarker(color: TagColor | undefined): string {
  return color ? TAG_COLOR_MARKERS[color] : '';
}

export function tagThemeColor(color: TagColor | undefined): vscode.ThemeColor | undefined {
  return color ? new vscode.ThemeColor(`charts.${color}`) : undefined;
}

export class TagColorStore {
  private colors = new Map<string, TagColor>();
  private loadPromise: Promise<TagSummary[]> | undefined;

  public constructor(private readonly loadTags: () => Promise<TagSummary[]>) {}

  public load(): Promise<TagSummary[]> {
    this.loadPromise ??= this.loadTags().then((summaries) => {
      this.colors = new Map(
        summaries
          .filter((summary): summary is TagSummary & { color: TagColor } => Boolean(summary.color))
          .map((summary) => [summary.tag.trim().toLowerCase(), summary.color]),
      );
      return summaries;
    });
    return this.loadPromise;
  }

  public refresh(): void {
    this.loadPromise = undefined;
    this.colors.clear();
  }

  public colorFor(tag: string): TagColor | undefined {
    return this.colors.get(tag.trim().replace(/^#/, '').trim().toLowerCase());
  }
}
