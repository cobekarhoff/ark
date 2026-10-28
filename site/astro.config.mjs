import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  output: 'static',
  integrations: [starlight({
    title: 'Ark',
    description: 'Agents do the work. Humans own the decisions.',
    customCss: ['./src/styles.css'],
    sidebar: [
      { label: 'Start here', items: [
        { label: 'What is Ark?', slug: '' },
        { label: 'Setup and first ticket', slug: 'setup' },
        { label: 'Lifecycle and human gates', slug: 'lifecycle' },
        { label: 'Agents and models', slug: 'agents' },
        { label: 'Tests and trace matrix', slug: 'evidence' },
        { label: 'Explore a run', slug: 'flow' },
      ] },
      { label: 'Reference', items: [
        { label: 'Command-line interface', slug: 'reference/commands' },
        { label: 'Implementation details', slug: 'reference/implementation' },
      ] },
    ],
  })],
});
