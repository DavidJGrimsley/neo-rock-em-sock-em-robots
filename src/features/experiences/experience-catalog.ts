import type { Href } from 'expo-router';

export const showcase = {
  name: "Neo Rock 'Em Sock 'Em Robots",
  description: 'Tabletop AR robot combat with solo and multiplayer modes.',
} as const;

export const experiences = [
  {
    route: 'arena-fighter',
    href: '/arena-fighter',
    title: "Neo Rock 'Em Sock 'Em Robots",
  },
] as const satisfies readonly { route: string; href: Href; title: string }[];
