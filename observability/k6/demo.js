import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.API_URL || 'http://api:5000';
const SUPERUSER_PASSWORD = __ENV.SUPERUSER_PASSWORD;

if (!SUPERUSER_PASSWORD) {
  throw new Error('SUPERUSER_PASSWORD env var is required');
}

export const options = {
  scenarios: {
    participants: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 30 },
        { duration: '1m',  target: 80 },
        { duration: '30s', target: 150 },
        { duration: '2m',  target: 150 },
        { duration: '20s', target: 0 },
      ],
      exec: 'participantFlow',
    },
    organizer_actions: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 5 },
        { duration: '1m',  target: 15 },
        { duration: '30s', target: 30 },
        { duration: '2m',  target: 30 },
        { duration: '20s', target: 0 },
      ],
      exec: 'organizerFlow',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.20'],
    http_req_duration: ['p(95)<5000'],
  },
};

function headers(userId) {
  return {
    'X-Auth-User': userId,
    'X-Auth-User-Email': `${userId}@k6loadtest.com`,
    'Content-Type': 'application/json',
  };
}

function post(path, body, userId) {
  return http.post(`${BASE_URL}${path}`, body ? JSON.stringify(body) : null, { headers: headers(userId) });
}

function put(path, body, userId) {
  return http.put(`${BASE_URL}${path}`, body ? JSON.stringify(body) : null, { headers: headers(userId) });
}

function get(path, userId) {
  return http.get(`${BASE_URL}${path}`, { headers: headers(userId) });
}

function del(path, userId) {
  return http.del(`${BASE_URL}${path}`, null, { headers: headers(userId) });
}

const DOMAINS = ['backend', 'frontend', 'mobile', 'ai', 'devops'];
const PARTICIPANT_TYPES = ['student', 'schoolchild'];
const COMPETITION_PARTICIPANT_TYPES = ['student', 'schoolchild', 'any'];
const EXPERIENCE_LEVELS = ['JUNIOR', 'MID', 'SENIOR'];
const SKILL_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

function randomDomains() {
  const count = randomIntBetween(1, 3);
  const shuffled = DOMAINS.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function futureDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

function competitionBody(domains, participantType, registrationStart) {
  return {
    title: `Demo Competition`,
    description: 'Auto-generated competition for observability load testing.',
    schedule: {
      registration_start: registrationStart,
      registration_end: futureDate(30),
    },
    participant_limits: { max: 500 },
    domains: domains,
    participant_type: participantType,
    venue: { format: 'online', location: null },
    team_size: { min: 1, max: 4 },
    auto_accept: false,
    milestones: [
      {
        timestamp: futureDate(7),
        title: 'Kickoff',
        description: 'Teams assemble and confirm problem statements.',
      },
      {
        timestamp: futureDate(20),
        title: 'Mid-point check-in',
        description: null,
      },
    ],
  };
}

export function setup() {
  const adminId = uuidv4();
  const runTag = Date.now().toString(36);

  const superuserRes = post('/users/superuser/', { password: SUPERUSER_PASSWORD }, adminId);
  check(superuserRes, { 'superuser registered': (r) => r.status === 200 });

  const competitions = [];
  const NUM_ORGANIZERS = 5;

  for (let i = 0; i < NUM_ORGANIZERS; i++) {
    const inviteRes = post('/invites/', { display_name: `k6-${runTag}-${i}` }, adminId);
    check(inviteRes, { 'invite issued': (r) => r.status === 200 });
    if (inviteRes.status !== 200) continue;

    const inviteCode = JSON.parse(inviteRes.body).code;
    const orgId = uuidv4();
    const phone = `+79${String(Math.floor(Math.random() * 900000000) + 100000000)}`;

    const orgRes = post('/organizers/', {
      organizer_name: `K6 Org ${runTag} ${i}`,
      phone_number: phone,
      contact_email: `k6org${runTag}${i}@k6loadtest.com`,
      invite_code: inviteCode,
    }, orgId);
    check(orgRes, { 'organizer registered': (r) => r.status === 200 });
    if (orgRes.status !== 200) continue;

    const domains = randomDomains();
    const participantType = COMPETITION_PARTICIPANT_TYPES[i % COMPETITION_PARTICIPANT_TYPES.length];
    const registrationStart = new Date(Date.now() + 500).toISOString();
    const body = competitionBody(domains, participantType, registrationStart);

    const compRes = post('/competitions/', body, orgId);
    check(compRes, { 'competition created': (r) => r.status === 200 });
    if (compRes.status !== 200) continue;

    const compId = JSON.parse(compRes.body).competition_id;

    // Publish: competitions start archived=true, must set is_archived=false to accept applications
    const publishRes = put(`/competitions/${compId}`, { ...body, is_archived: false }, orgId);
    check(publishRes, { 'competition published': (r) => r.status === 200 });

    // Create application form for even-indexed competitions
    let hasForm = false;
    if (i % 2 === 0) {
      const formRes = post(`/competitions/${compId}/application-form/`, {
        fields: [
          { name: 'motivation', label: 'Why do you want to join?', type: 'string', required: true },
          { name: 'experience_years', label: 'Years of experience', type: 'int', required: false },
          { name: 'role', label: 'Preferred role', type: 'select', required: true,
            choices: [
              { value: 'frontend', label: 'Frontend' },
              { value: 'backend', label: 'Backend' },
              { value: 'devops', label: 'DevOps' },
            ]
          },
        ],
      }, orgId);
      check(formRes, { 'application form created': (r) => r.status === 200 });
      hasForm = formRes.status === 200;
    }

    competitions.push({ id: compId, organizer_id: orgId, domains: domains, participant_type: participantType, has_form: hasForm });
  }

  // Wait for registration windows to open (created with +500ms offset)
  sleep(2);
  return { competitions };
}

export function participantFlow(data) {
  const { competitions } = data;
  if (!competitions || competitions.length === 0) return;

  const userId = uuidv4();
  const idx = __VU % 3;

  // Register as participant
  const regRes = post('/participants/', {
    full_name: `K6 Participant ${userId.slice(0, 8)}`,
    participant_type: PARTICIPANT_TYPES[idx % PARTICIPANT_TYPES.length],
    age: randomIntBetween(17, 35),
    bio: 'Auto-generated demo participant for observability load testing.',
    experience_level: EXPERIENCE_LEVELS[idx % EXPERIENCE_LEVELS.length],
    skills: [
      { name: 'Python', level: SKILL_LEVELS[randomIntBetween(0, 3)] },
      { name: 'TypeScript', level: SKILL_LEVELS[randomIntBetween(0, 3)] },
    ],
    preferred_domains: randomDomains(),
  }, userId);

  check(regRes, { 'participant registered': (r) => r.status === 200 });
  if (regRes.status !== 200) {
    sleep(1);
    return;
  }

  sleep(0.2);

  // Browse competitions — anonymous preview
  const previewRes = get('/competitions/preview?page=1', userId);
  check(previewRes, { 'competitions listed (preview)': (r) => r.status === 200 });

  sleep(0.2);

  // Participant-facing explore with rich filters — mix of default and filtered requests
  const explorePaths = [
    '/competitions/explore?sort_by=most_popular&page=1',
    '/competitions/explore?sort_by=newest&page=1',
    `/competitions/explore?sort_by=most_popular&domains=${DOMAINS[randomIntBetween(0, DOMAINS.length - 1)]}`,
    `/competitions/explore?sort_by=most_popular&min_team_size=1&max_team_size=4`,
    '/competitions/explore?sort_by=most_popular&auto_accept=false',
  ];
  const exploreRes = get(explorePaths[randomIntBetween(0, explorePaths.length - 1)], userId);
  check(exploreRes, { 'competitions explored': (r) => r.status === 200 });

  sleep(0.2);

  // Submit application to a compatible competition (type must match or be 'any')
  const myType = PARTICIPANT_TYPES[idx % PARTICIPANT_TYPES.length];
  const eligible = competitions.filter(c => c.participant_type === 'any' || c.participant_type === myType);
  if (eligible.length === 0) { sleep(1); return; }
  const comp = eligible[randomIntBetween(0, eligible.length - 1)];
  const appDomains = comp.domains.slice(0, randomIntBetween(1, comp.domains.length));
  // form_data must be null when competition has no form; must match exact fields when it does
  const formData = comp.has_form
    ? { motivation: 'I want to build something great', experience_years: 3, role: 'backend' }
    : null;
  const appRes = post(`/competitions/${comp.id}/applications/`, {
    domains: appDomains,
    form_data: formData,
  }, userId);
  check(appRes, { 'application submitted': (r) => r.status === 200 || r.status === 409 || r.status === 403 });

  sleep(0.2);

  // View own profile
  const profileRes = get('/users/me', userId);
  check(profileRes, { 'profile loaded': (r) => r.status === 200 });

  sleep(0.2);

  // List own applications — exercise sort + status filter variants
  const myAppsPaths = [
    '/applications/?sort_by=created_at&sort_order=desc',
    '/applications/?sort_by=created_at&sort_order=asc',
    '/applications/?status=pending',
    '/applications/?status=accepted',
    '/applications/?status=rejected',
  ];
  const myAppsRes = get(myAppsPaths[randomIntBetween(0, myAppsPaths.length - 1)], userId);
  check(myAppsRes, { 'my applications listed': (r) => r.status === 200 });

  // Occasionally withdraw a pending application
  if (appRes.status === 200 && Math.random() < 0.15) {
    sleep(0.3);
    const appId = JSON.parse(appRes.body).application_id;
    const withdrawRes = del(`/applications/${appId}/`, userId);
    check(withdrawRes, { 'application withdrawn': (r) => r.status === 200 || r.status === 204 || r.status === 409 || r.status === 422 });
  }

  sleep(randomIntBetween(1, 2));
}

export function organizerFlow(data) {
  const { competitions } = data;
  if (!competitions || competitions.length === 0) return;

  const comp = competitions[__VU % competitions.length];

  // List applications for this competition — exercise sort + status filter variants
  const organizerListPaths = [
    `/competitions/${comp.id}/applications/?sort_by=created_at&sort_order=desc`,
    `/competitions/${comp.id}/applications/?sort_by=created_at&sort_order=asc`,
    `/competitions/${comp.id}/applications/?status=pending`,
    `/competitions/${comp.id}/applications/?status=accepted`,
    `/competitions/${comp.id}/applications/?status=rejected`,
  ];
  const listRes = get(organizerListPaths[randomIntBetween(0, organizerListPaths.length - 1)], comp.organizer_id);
  check(listRes, { 'applications listed': (r) => r.status === 200 });

  // Always re-read pending applications for accept/reject triage
  const pendingRes = get(`/competitions/${comp.id}/applications/?status=pending`, comp.organizer_id);
  if (pendingRes.status === 200) {
    const items = JSON.parse(pendingRes.body).items || [];
    for (const app of items.slice(0, 5)) {
      sleep(0.15);
      const action = Math.random() > 0.3 ? 'accept' : 'reject';
      const actionRes = post(`/applications/${app.id}/${action}/`, null, comp.organizer_id);
      check(actionRes, { [`app ${action}ed`]: (r) => r.status === 200 || r.status === 204 || r.status === 409 || r.status === 422 });
    }
  }

  sleep(0.3);

  // Read application form (for competitions that have one)
  const formRes = get(`/competitions/${comp.id}/application-form/`, comp.organizer_id);
  check(formRes, { 'form read or missing': (r) => r.status === 200 || r.status === 404 });

  sleep(randomIntBetween(1, 3));
}
