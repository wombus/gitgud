/**
 * The cast of Conglomo Corp. Every IM in the game comes from one of these people.
 */

export type CharacterId = 'dana' | 'greg' | 'priya' | 'todd' | 'marcus' | 'it' | 'people' | 'system';

export interface Character {
  id: CharacterId;
  name: string;
  title: string;
  initials: string;
  /** Avatar background color. */
  color: string;
  /** Pingr presence dot. */
  status: 'online' | 'away' | 'dnd';
  statusText?: string;
}

export const CHARACTERS: Record<CharacterId, Character> = {
  dana: {
    id: 'dana',
    name: 'Dana Whitfield',
    title: 'Engineering Manager',
    initials: 'DW',
    color: '#7c5cff',
    status: 'online',
    statusText: 'In back-to-back meetings until 2031',
  },
  greg: {
    id: 'greg',
    name: 'Greg Hollis',
    title: 'Staff Engineer (14 yrs)',
    initials: 'GH',
    color: '#e0803a',
    status: 'dnd',
    statusText: 'Do not @ me',
  },
  priya: {
    id: 'priya',
    name: 'Priya Raman',
    title: 'Site Reliability Engineer',
    initials: 'PR',
    color: '#2bb38a',
    status: 'online',
    statusText: 'on call (forever)',
  },
  todd: {
    id: 'todd',
    name: 'Todd Brennan',
    title: 'Engineering Intern',
    initials: 'TB',
    color: '#e8517a',
    status: 'online',
    statusText: 'learning so much!!! 🚀',
  },
  marcus: {
    id: 'marcus',
    name: 'Marcus Vale',
    title: 'CTO',
    initials: 'MV',
    color: '#3a8fe0',
    status: 'away',
    statusText: 'thinking about the blockchain',
  },
  it: {
    id: 'it',
    name: 'IT Helpdesk Bot',
    title: 'Automated',
    initials: 'IT',
    color: '#6b7280',
    status: 'online',
    statusText: 'Your ticket is important to us',
  },
  people: {
    id: 'people',
    name: 'PeopleOps',
    title: 'Culture & Engagement',
    initials: 'PO',
    color: '#d9a31c',
    status: 'online',
    statusText: 'Mandatory Fun Coordinator',
  },
  system: {
    id: 'system',
    name: 'GitHub',
    title: 'Notifications',
    initials: 'GH',
    color: '#24292f',
    status: 'online',
  },
};

export function character(id: CharacterId): Character {
  return CHARACTERS[id];
}

/** Git identities for coworkers (used as commit authors). */
export const AUTHORS = {
  dana: { name: 'Dana Whitfield', email: 'dana.whitfield@conglomo.com' },
  greg: { name: 'Greg Hollis', email: 'greg@conglomo.com' },
  priya: { name: 'Priya Raman', email: 'priya.raman@conglomo.com' },
  todd: { name: 'Todd Brennan', email: 'todd.brennan@conglomo.com' },
  marcus: { name: 'Marcus Vale', email: 'marcus@conglomo.com' },
  gary: { name: 'Gary Pruitt', email: 'gary.pruitt@conglomo.com' },
};
