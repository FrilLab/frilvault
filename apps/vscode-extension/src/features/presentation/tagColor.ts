import * as vscode from 'vscode';

import type { TagColor } from '../../types';

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
