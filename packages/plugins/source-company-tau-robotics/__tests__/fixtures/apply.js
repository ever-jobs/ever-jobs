// Careers application flow: role details from ?role=, then a JSON POST to
// /api/apply. The function stores the application in Firestore and emails a
// backstop copy — if it reports failure we fall back to plain email, so an
// applicant always has a way to reach us.
//
// Role slugs must stay in sync with APPLY_ROLES in functions/index.js.

(() => {
  'use strict';

  const API = window.BOOKING_API || '/api';
  const endpoint =
    (window.BOOKING_ENDPOINTS && window.BOOKING_ENDPOINTS.apply) || `${API}/apply`;

  const CONTACT_EMAIL = 'cornelia@tau-robotics.com';

  // Shown at the top of every role page, before the role-specific text.
  const MISSION =
    'Our mission is to build a general-purpose AI for robots. We believe the ' +
    'path is to deploy robots early in real customer environments, learn from ' +
    'large-scale real-world experience, and steadily increase autonomy and ' +
    'performance beyond human levels. Join a focused team building this system ' +
    'end to end, with significant ownership and meaningful equity.';

  const ROLES = {
    'world-models': {
      title: 'Research Engineer/Scientist, World Models',
      meta: 'Research · San Francisco · Full-time',
      responsibilities: [
        'Develop and implement new algorithms for training world models',
        'Train deep neural networks on large GPU clusters',
        'Collaborate with robot learning researchers to train robot foundation models',
      ],
      requirements: [
        'Deep technical knowledge and research experience in large generative models',
        'Experience implementing learning algorithms for video or image generation',
        'Extensive Python proficiency and familiarity with deep learning libraries (PyTorch or JAX)',
        'Publications at top venues (NeurIPS, ICLR, ICML, CVPR, RSS, CoRL, ICRA), or equivalent public evidence',
      ],
    },
    'reinforcement-learning': {
      title: 'Research Engineer/Scientist, Reinforcement Learning',
      meta: 'Research · San Francisco · Full-time',
      responsibilities: [
        'Create and deploy model-based reinforcement learning algorithms',
        'Train deep neural networks on large GPU clusters',
        'Partner with researchers specializing in imitation learning and world models',
      ],
      requirements: [
        'Strong background in deep learning and reinforcement or imitation learning',
        'Proven ability to implement and debug reinforcement learning algorithms',
        'Proficiency with Python and deep learning frameworks like JAX or PyTorch',
        'Publications at premier venues (NeurIPS, ICLR, ICML, CVPR, RSS, CoRL, ICRA), or equivalent public evidence',
      ],
    },
    'imitation-learning': {
      title: 'Research Engineer/Scientist, Imitation Learning & Pretraining',
      meta: 'Research · San Francisco · Full-time',
      responsibilities: [
        'Build and scale supervised pretraining runs on large multi-modal robot datasets',
        'Train multi-task manipulation policies and study what actually transfers',
        'Define the finetuning recipes that hand pretrained policies to the RL loop',
      ],
      requirements: [
        'Experience with large-scale pretraining, behaviour cloning, or vision-language-action models',
        'Comfort building data pipelines for large multimodal datasets',
        'Strong Python plus PyTorch or JAX',
        'Evidence: papers, repos, or models you trained that others used',
      ],
    },
    'simulation-evaluation': {
      title: 'Research Engineer, Simulation & Evaluation',
      meta: 'Research · San Francisco · Full-time',
      responsibilities: [
        'Build simulation environments that mirror our deployment homes and tasks',
        'Design automated evaluation suites that gate every policy release',
        'Correlate simulation metrics with real-world outcomes and close the gap',
      ],
      requirements: [
        'Strong software engineering in Python and C++',
        'Hands-on experience with robotics simulators (MuJoCo, Isaac, or similar)',
        'A record of building benchmarks or test harnesses people actually trusted',
      ],
    },
    'systems-connectivity': {
      title: 'Robotics Software Engineer, Systems & Connectivity',
      meta: 'Software · San Francisco · Full-time',
      responsibilities: [
        'Build and harden the on-robot software: drivers, control loops, updates',
        'Minimize robot communication latency and maximize reliability',
        'Ensure correctness of recorded data',
      ],
      requirements: [
        'Strong C++ or Rust, comfortable in Python',
        'Experience with real-time or embedded systems on physical hardware',
        'Low-latency networking experience (WebRTC, QUIC, or similar)',
      ],
    },
    'robot-data-infrastructure': {
      title: 'Software Engineer, Robot Data Infrastructure',
      meta: 'Software · San Francisco · Full-time',
      responsibilities: [
        'Build pipelines that ingest terabytes of episode data from the fleet',
        'Design storage and indexing that make any episode findable in seconds',
        'Build the dataset tooling for search, curation, and labeling that the research team lives in',
      ],
      requirements: [
        'Strong Python and production data-infrastructure experience',
        'Experience with cloud storage and large-scale processing pipelines',
        'Video processing or compression experience is a plus',
      ],
    },
    'hardware-prototyping': {
      title: 'Robotics Hardware Engineer, Prototyping & Integration',
      meta: 'Hardware · San Francisco · Full-time',
      responsibilities: [
        'Design grippers, robot heads, mounts, and enclosures',
        'Select and source motors, sensors, cameras, connectors, and other components',
        'Prototype mechanical and electromechanical assemblies',
        'Build antenna and wireless hardware configurations',
        'Design and assemble teleoperation stations',
        'Integrate mechanical, electrical, and computing components into working systems',
        'Work with our technicians to assemble and maintain what you build',
      ],
      requirements: [
        'Strong CAD and rapid prototyping skills: 3D printing, machining, fast iteration',
        'Broad electromechanical fluency: motors, sensors, wiring, connectors, power',
        'A portfolio of integrated systems you designed, built, and made work outside the lab',
        'RF or wireless hardware experience is a plus',
      ],
    },
    'robotics-technician': {
      title: 'Robotics Technician, Assembly & Maintenance',
      meta: 'Hardware · San Francisco · Full-time',
      responsibilities: [
        'Assemble, wire, and calibrate robots and their grippers',
        'Diagnose and repair mechanical and electrical failures fast',
        'Own spares, tooling, and the preventive maintenance schedule',
      ],
      requirements: [
        'Hands-on electromechanical skills: wiring, soldering, 3D printing, careful assembly',
        'Systematic debugging instincts that find root causes, not just symptoms',
        'Background in robotics, RC, machine shops, or similar hands-on work welcome',
      ],
    },
    'open-application': {
      title: 'Something else',
      meta: 'San Francisco · You tell us',
      about:
        'We hire ahead of job postings when we meet exceptional people. If none ' +
        'of the open roles fit but you think you belong here, tell us what you ' +
        'would do at Tau Robotics, with evidence.',
      responsibilities: [],
      requirements: [],
    },
  };

  const params = new URLSearchParams(location.search);
  const slug = params.get('role') || 'open-application';
  const role = ROLES[slug];

  const titleEl = document.getElementById('roleTitle');
  const metaEl = document.getElementById('roleMeta');
  const bodyEl = document.getElementById('roleBody');
  const form = document.getElementById('applyForm');
  const msg = document.getElementById('applyMsg');
  const submitBtn = document.getElementById('applyBtn');

  if (!role) {
    titleEl.textContent = 'Role not found.';
    bodyEl.innerHTML =
      '<p class="apply__about">That opening doesn&rsquo;t exist (any more). ' +
      'See the <a class="link" href="careers.html">current openings</a>.</p>';
    return;
  }

  document.title = `${role.title} | Tau Robotics`;
  titleEl.textContent = `${role.title}.`;
  metaEl.textContent = role.meta;

  const list = (heading, items) =>
    items.length
      ? `<h2 class="apply__h">${heading}</h2>
         <ul class="apply__list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
      : '';

  // Role content is our own static data above — safe to inject as markup.
  bodyEl.innerHTML = `
    <p class="apply__about">${MISSION}</p>
    ${role.about ? `<p class="apply__about">${role.about}</p>` : ''}
    ${list('What you’ll do', role.responsibilities)}
    ${list('What we look for', role.requirements)}
  `;
  form.hidden = false;

  /* One-click prompt so candidates can have their own AI draft the text */
  const agentPrompt =
    `I'm applying to Tau Robotics for the role ${role.title} ` +
    `(${location.origin}/apply.html?role=${slug}). Help me fill in the application.\n\n` +
    `The form asks for: name, email, current location, GitHub, LinkedIn, ` +
    `website/portfolio, an optional free-text field ("Anything else you'd like us ` +
    `to know"), and an optional PDF resume. Any one piece of evidence is enough, ` +
    `whether text, a resume, a GitHub, or a homepage, and they say to leave fields ` +
    `empty if they're not needed.\n\n` +
    `What they look for: things I actually built, with links and my part in them. ` +
    `Specifics beat polish; claims without evidence are ignored. If my best work is ` +
    `under NDA, I should say so and offer references.\n\n` +
    `Draft the free-text field for me: short and concrete, links first. Cover what I ` +
    `built, what my part was, and any constraints worth stating (location, visa, ` +
    `timing). Use only facts and links I give you or that are verifiably mine. ` +
    `Do not invent or inflate anything.`;

  const copyBtn = document.getElementById('copyPrompt');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt);
      copyBtn.textContent = 'copied ✓';
      setTimeout(() => { copyBtn.textContent = 'copy a prompt for your AI agent'; }, 2000);
    } catch {
      copyBtn.textContent = 'copy failed';
    }
  });

  /* Submit */
  const MAX_RESUME_BYTES = 10 * 1024 * 1024;

  const readResume = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read_failed'));
      // strip the data:application/pdf;base64, prefix — the API wants raw base64
      reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
      reader.readAsDataURL(file);
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const value = (name) => form.elements[name].value.trim();
    const payload = {
      role: slug,
      hp_leave_empty: value('hp_leave_empty'), // honeypot
      name: value('name'),
      email: value('email'),
      location: value('location'),
      github: value('github'),
      linkedin: value('linkedin'),
      website: value('website'),
      pitch: value('pitch'),
    };

    const resumeFile = form.elements.resume.files[0];
    if (resumeFile) {
      if (resumeFile.type !== 'application/pdf' && !/\.pdf$/i.test(resumeFile.name)) {
        msg.textContent = 'The resume must be a PDF.';
        return;
      }
      if (resumeFile.size > MAX_RESUME_BYTES) {
        msg.textContent = 'The resume is larger than 10 MB. Please attach a smaller PDF.';
        return;
      }
    }

    if (!payload.name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) {
      msg.textContent = 'Please fill in your name and a valid email.';
      return;
    }
    if (!payload.pitch && !resumeFile && !payload.github && !payload.website) {
      msg.textContent =
        'Please give us something to look at: text, a resume, a GitHub, or a homepage.';
      return;
    }

    submitBtn.disabled = true;
    msg.textContent = 'Sending…';

    try {
      if (resumeFile) payload.resume = await readResume(resumeFile);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      form.hidden = true;
      bodyEl.innerHTML += `
        <p class="apply__done">Thanks! We received your application for
        <strong>${role.title}</strong> and will get back to you soon.</p>`;
    } catch (err) {
      console.error(err);
      submitBtn.disabled = false;
      msg.innerHTML =
        'Something went wrong on our end and your application was not saved. ' +
        `please email it to <a class="link" href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> instead.`;
    }
  });
})();
