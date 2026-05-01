import http from "k6/http";
import { check, sleep } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { randomIntBetween } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = __ENV.API_URL || "http://api:5000";
const SUPERUSER_PASSWORD = __ENV.SUPERUSER_PASSWORD;

if (!SUPERUSER_PASSWORD) {
    throw new Error("SUPERUSER_PASSWORD env var is required");
}

export const options = {
    setupTimeout: "120s",
    scenarios: {
        participants: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: "20s", target: 30 },
                { duration: "1m", target: 80 },
                { duration: "30s", target: 150 },
                { duration: "2m", target: 150 },
                { duration: "20s", target: 0 },
            ],
            exec: "participantFlow",
        },
        organizer_actions: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: "20s", target: 5 },
                { duration: "1m", target: 15 },
                { duration: "30s", target: 30 },
                { duration: "2m", target: 30 },
                { duration: "20s", target: 0 },
            ],
            exec: "organizerFlow",
        },
    },
    thresholds: {
        http_req_failed: ["rate<0.20"],
        http_req_duration: ["p(95)<5000"],
    },
};

function headers(userId) {
    return {
        "X-Auth-User": userId,
        "X-Auth-User-Email": `${userId}@k6loadtest.com`,
        "Content-Type": "application/json",
    };
}

function post(path, body, userId) {
    return http.post(`${BASE_URL}${path}`, body ? JSON.stringify(body) : null, {
        headers: headers(userId),
    });
}

function put(path, body, userId) {
    return http.put(`${BASE_URL}${path}`, body ? JSON.stringify(body) : null, {
        headers: headers(userId),
    });
}

function patch(path, body, userId) {
    return http.patch(
        `${BASE_URL}${path}`,
        body ? JSON.stringify(body) : null,
        { headers: headers(userId) },
    );
}

function get(path, userId) {
    return http.get(`${BASE_URL}${path}`, { headers: headers(userId) });
}

function del(path, userId) {
    return http.del(`${BASE_URL}${path}`, null, { headers: headers(userId) });
}

const PARTICIPANT_TYPES = ["student", "schoolchild"];
const COMPETITION_PARTICIPANT_TYPES = ["student", "schoolchild", "any"];
const EXPERIENCE_LEVELS = ["JUNIOR", "MID", "SENIOR"];
const SKILL_LEVELS = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];
const COMPETITION_FORMATS = ["online", "offline", "hybrid"];

function randomTags(count) {
    const tags = [
        "AI",
        "Web",
        "Mobile",
        "DevOps",
        "Security",
        "Data Science",
        "Cloud",
        "IoT",
    ];
    const shuffled = tags.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

function futureDate(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString();
}

function competitionBody() {
    const format = COMPETITION_FORMATS[randomIntBetween(0, 2)];
    const needsLocation = format === "offline" || format === "hybrid";
    const hasTeamSize = Math.random() > 0.3;

    const schedule = {
        registration_start: new Date(Date.now() + 500).toISOString(),
        registration_end: futureDate(30),
    };

    if (hasTeamSize) {
        schedule.team_formation_start = futureDate(30);
        schedule.team_formation_end = futureDate(45);
    } else {
        schedule.team_formation_start = null;
        schedule.team_formation_end = null;
    }

    return {
        title: `K6 Competition ${Date.now().toString(36)}-${randomIntBetween(0, 99999)}`,
        description: "Auto-generated competition for load testing.",
        schedule: schedule,
        participant_limits: { max: 500 },
        tag_ids: [],
        tracks: [{ name: "Track A" }, { name: "Track B" }],
        participant_type: COMPETITION_PARTICIPANT_TYPES[randomIntBetween(0, 2)],
        venue: {
            format: format,
            location: needsLocation ? "Moscow, Russia" : null,
        },
        team_size: hasTeamSize ? { min: 1, max: 4 } : null,
        auto_accept: Math.random() > 0.5,
        milestones: [
            {
                timestamp: futureDate(7),
                title: "Kickoff",
                description: "Teams assemble and confirm problem statements.",
            },
            {
                timestamp: futureDate(20),
                title: "Mid-point check-in",
                description: null,
            },
        ],
    };
}

export function setup() {
    console.log("=== SETUP STARTED ===");
    const adminId = uuidv4();

    // Register superuser
    const superuserRes = post(
        "/users/superuser/",
        { password: SUPERUSER_PASSWORD },
        adminId,
    );
    check(superuserRes, { "superuser registered": (r) => r.status === 200 });
    console.log(`Superuser registered: ${superuserRes.status}`);

    // Create tags
    const tagIds = [];
    const tagsToCreate = [
        "AI",
        "Web",
        "Mobile",
        "DevOps",
        "Security",
        "Data Science",
        "Cloud",
        "IoT",
        "Blockchain",
        "ML",
    ];
    for (const tag of tagsToCreate) {
        const tagRes = post("/admin/tags/", { value: tag }, adminId);
        if (tagRes.status === 200) {
            const tagId = JSON.parse(tagRes.body).id;
            tagIds.push(tagId);
        }
    }
    console.log(`Tags created: ${tagIds.length}`);

    const competitions = [];
    const NUM_ORGANIZERS = 50;
    const COMPS_PER_ORG = 10;
    let createdComps = 0;
    let activatedComps = 0;
    let formErrors = 0;

    for (let i = 0; i < NUM_ORGANIZERS; i++) {
        // Issue invite
        const inviteRes = post(
            "/invites/",
            { display_name: `org-${i}-${Date.now().toString(36)}` },
            adminId,
        );
        check(inviteRes, { "invite issued": (r) => r.status === 200 });
        if (inviteRes.status !== 200) {
            console.log(`Failed to issue invite for org ${i}`);
            continue;
        }

        const inviteCode = JSON.parse(inviteRes.body).code;
        const orgId = uuidv4();
        const phone = `+79${String(Math.floor(Math.random() * 900000000) + 100000000)}`;

        // Register organizer
        const orgRes = post(
            "/organizers/",
            {
                organizer_name: `K6 Org ${i}-${Date.now().toString(36)}`,
                phone_number: phone,
                invite_code: inviteCode,
            },
            orgId,
        );
        check(orgRes, { "organizer registered": (r) => r.status === 200 });
        if (orgRes.status !== 200) {
            console.log(`Failed to register organizer ${i}`);
            continue;
        }

        // Create competitions for this organizer
        for (let j = 0; j < COMPS_PER_ORG; j++) {
            const body = competitionBody();
            body.tag_ids = tagIds
                .sort(() => Math.random() - 0.5)
                .slice(0, randomIntBetween(1, 3));

            // CREATE COMPETITION
            const compRes = post("/competitions/", body, orgId);
            if (compRes.status !== 200) {
                console.log(
                    `Failed to create competition ${i}-${j}: ${compRes.status}`,
                );
                continue;
            }
            createdComps++;

            const compId = JSON.parse(compRes.body).competition_id;

            // ACTIVATE COMPETITION IMMEDIATELY
            const activateRes = patch(
                `/competitions/${compId}/archive-status`,
                { is_archived: false },
                orgId,
            );
            if (activateRes.status === 200) {
                activatedComps++;
            } else {
                console.log(
                    `Failed to activate comp ${compId}: ${activateRes.status}`,
                );
            }

            // Create application form for some competitions
            let hasForm = false;
            if (j % 2 === 0) {
                const formRes = post(
                    `/competitions/${compId}/application-form/`,
                    {
                        fields: [
                            {
                                name: "motivation",
                                type: "string",
                                required: true,
                                choices: null,
                            },
                            {
                                name: "experience_years",
                                type: "int",
                                required: false,
                                choices: null,
                            },
                            {
                                name: "role",
                                type: "select",
                                required: true,
                                choices: [
                                    { value: "frontend" },
                                    { value: "backend" },
                                    { value: "devops" },
                                ],
                            },
                        ],
                    },
                    orgId,
                );
                hasForm = formRes.status === 200;
                if (!hasForm) formErrors++;
            }

            competitions.push({
                id: compId,
                organizer_id: orgId,
                tracks: body.tracks,
                participant_type: body.participant_type,
                has_form: hasForm,
                is_archived: false,
            });
        }

        // Progress indicator
        if ((i + 1) % 10 === 0) {
            console.log(
                `Progress: ${i + 1}/${NUM_ORGANIZERS} organizers done. Comps: ${createdComps}, Activated: ${activatedComps}`,
            );
        }
    }

    console.log(`=== SETUP COMPLETE ===`);
    console.log(`Total competitions: ${competitions.length}`);
    console.log(`Created: ${createdComps}, Activated: ${activatedComps}`);
    console.log(`With forms: ${competitions.filter((c) => c.has_form).length}`);
    console.log(`Form errors: ${formErrors}`);

    sleep(3); // Wait for all data to be committed
    return { competitions, tagIds, adminId };
}

export function participantFlow(data) {
    const { competitions } = data;
    if (!competitions || competitions.length === 0) return;

    const userId = uuidv4();
    const idx = __VU % 3;

    // Register as participant
    const regRes = post(
        "/participants/",
        {
            full_name: `K6 Participant ${userId.slice(0, 8)}`,
            participant_type: PARTICIPANT_TYPES[idx % PARTICIPANT_TYPES.length],
            age: randomIntBetween(17, 35),
            bio: "Auto-generated demo participant for load testing.",
            experience_level: EXPERIENCE_LEVELS[idx % EXPERIENCE_LEVELS.length],
            skills: [
                { name: "Python", level: SKILL_LEVELS[randomIntBetween(0, 3)] },
                {
                    name: "TypeScript",
                    level: SKILL_LEVELS[randomIntBetween(0, 3)],
                },
            ],
            contacts: [
                { title: "Telegram", value: `@user_${userId.slice(0, 8)}` },
                { title: "GitHub", value: `gh_${userId.slice(0, 8)}` },
            ],
        },
        userId,
    );

    check(regRes, { "participant registered": (r) => r.status === 200 });
    if (regRes.status !== 200) {
        sleep(1);
        return;
    }

    sleep(0.2);

    // Update participant profile (30% chance)
    if (Math.random() < 0.3) {
        const updateRes = put(
            "/users/me/participant",
            {
                full_name: `Updated ${userId.slice(0, 8)}`,
                participant_type:
                    PARTICIPANT_TYPES[idx % PARTICIPANT_TYPES.length],
                age: randomIntBetween(18, 40),
                bio: "Updated bio for testing PUT endpoint.",
                experience_level: EXPERIENCE_LEVELS[randomIntBetween(0, 2)],
                skills: [
                    { name: "Go", level: SKILL_LEVELS[randomIntBetween(0, 3)] },
                ],
                contacts: [
                    {
                        title: "Email",
                        value: `updated_${userId.slice(0, 8)}@test.com`,
                    },
                ],
            },
            userId,
        );
        check(updateRes, { "participant updated": (r) => r.status === 200 });
    }

    sleep(0.2);

    // Anonymous preview
    const previewRes = get("/competitions/preview?page=1", userId);
    check(previewRes, { "competitions preview": (r) => r.status === 200 });

    sleep(0.2);

    // Browse tags
    const tagsRes = get("/tags/?page=1", userId);
    check(tagsRes, { "tags listed": (r) => r.status === 200 });

    sleep(0.2);

    // Explore competitions with various filters
    const explorePaths = [
        "/competitions/explore?sort_by=most_popular&page=1",
        "/competitions/explore?sort_by=newest&page=1",
        "/competitions/explore?sort_by=most_popular&min_team_size=1&max_team_size=4",
        "/competitions/explore?sort_by=most_popular&auto_accept=true",
        "/competitions/explore?sort_by=newest&search=K6",
    ];
    const exploreRes = get(
        explorePaths[randomIntBetween(0, explorePaths.length - 1)],
        userId,
    );
    check(exploreRes, { "competitions explored": (r) => r.status === 200 });

    sleep(0.2);

    // Find eligible competitions (ACTIVE only + compatible type)
    const myType = PARTICIPANT_TYPES[idx % PARTICIPANT_TYPES.length];
    const eligible = competitions.filter(
        (c) =>
            !c.is_archived &&
            (c.participant_type === "any" || c.participant_type === myType),
    );

    if (eligible.length === 0) {
        sleep(1);
        return;
    }

    const comp = eligible[randomIntBetween(0, eligible.length - 1)];
    const track = comp.tracks[randomIntBetween(0, comp.tracks.length - 1)];

    // Read competition for submission
    const compReadRes = get(`/competitions/explore/${comp.id}`, userId);
    check(compReadRes, { "competition read": (r) => r.status === 200 });

    sleep(0.2);

    // Read application form ONLY if competition has one
    if (comp.has_form) {
        const formRes = get(
            `/competitions/${comp.id}/applications/form/`,
            userId,
        );
        check(formRes, {
            "form read": (r) => r.status === 200 || r.status === 404,
        });
    }

    sleep(0.2);

    // Submit application
    const formData = comp.has_form
        ? {
              motivation: "I want to build something great",
              experience_years: 3,
              role: "backend",
          }
        : null;

    const appRes = post(
        `/competitions/${comp.id}/applications/`,
        {
            track: { name: track.name },
            form_data: formData,
        },
        userId,
    );
    check(appRes, {
        "application submitted": (r) =>
            r.status === 200 ||
            r.status === 409 ||
            r.status === 403 ||
            r.status === 422,
    });

    sleep(0.2);

    // View profile
    const profileRes = get("/users/me", userId);
    check(profileRes, { "profile loaded": (r) => r.status === 200 });

    sleep(0.2);

    // List my applications with various filters
    const myAppsPaths = [
        "/applications/?sort_by=created_at&sort_order=desc",
        "/applications/?sort_by=created_at&sort_order=asc",
        "/applications/?status=pending",
        "/applications/?status=accepted",
        "/applications/?status=rejected",
    ];
    const myAppsRes = get(
        myAppsPaths[randomIntBetween(0, myAppsPaths.length - 1)],
        userId,
    );
    check(myAppsRes, { "my applications listed": (r) => r.status === 200 });

    // Read my application if submitted
    if (appRes.status === 200 && Math.random() < 0.3) {
        try {
            const appId = JSON.parse(appRes.body).application_id;
            const readMyAppRes = get(`/applications/${appId}/my/`, userId);
            check(readMyAppRes, {
                "my application read": (r) => r.status === 200,
            });
        } catch (e) {
            // JSON parse failed, skip
        }
    }

    // Withdraw application occasionally
    if (appRes.status === 200 && Math.random() < 0.15) {
        sleep(0.3);
        try {
            const appId = JSON.parse(appRes.body).application_id;
            const withdrawRes = del(`/applications/${appId}/`, userId);
            check(withdrawRes, {
                "application withdrawn": (r) =>
                    r.status === 200 ||
                    r.status === 204 ||
                    r.status === 409 ||
                    r.status === 422,
            });
        } catch (e) {
            // JSON parse failed, skip
        }
    }

    // Delete profile occasionally
    if (Math.random() < 0.05) {
        const deleteRes = del("/users/me", userId);
        check(deleteRes, {
            "profile deleted": (r) => r.status === 200 || r.status === 204,
        });
        return;
    }

    sleep(randomIntBetween(1, 2));
}

export function organizerFlow(data) {
    const { competitions } = data;
    if (!competitions || competitions.length === 0) return;

    const comp = competitions[__VU % competitions.length];

    // List competitions
    const listCompsRes = get(
        `/competitions/?sort_by=created_at&sort_order=desc`,
        comp.organizer_id,
    );
    check(listCompsRes, { "competitions listed": (r) => r.status === 200 });

    sleep(0.3);

    // Read competition
    const readCompRes = get(`/competitions/${comp.id}`, comp.organizer_id);
    check(readCompRes, { "competition read": (r) => r.status === 200 });

    sleep(0.3);

    // List applications with various filters
    const organizerListPaths = [
        `/competitions/${comp.id}/applications/?sort_by=created_at&sort_order=desc`,
        `/competitions/${comp.id}/applications/?sort_by=created_at&sort_order=asc`,
        `/competitions/${comp.id}/applications/?status=pending`,
        `/competitions/${comp.id}/applications/?status=accepted`,
        `/competitions/${comp.id}/applications/?status=rejected`,
        `/competitions/${comp.id}/applications/?page_size=10&page=1`,
    ];
    const listRes = get(
        organizerListPaths[randomIntBetween(0, organizerListPaths.length - 1)],
        comp.organizer_id,
    );
    check(listRes, { "applications listed": (r) => r.status === 200 });

    // Accept/reject pending applications
    const pendingRes = get(
        `/competitions/${comp.id}/applications/?status=pending`,
        comp.organizer_id,
    );
    if (pendingRes.status === 200) {
        try {
            const items = JSON.parse(pendingRes.body).items || [];
            for (const app of items.slice(0, 5)) {
                sleep(0.15);
                const action = Math.random() > 0.3 ? "accept" : "reject";
                const actionRes = post(
                    `/applications/${app.id}/${action}/`,
                    null,
                    comp.organizer_id,
                );
                check(actionRes, {
                    [`app ${action}ed`]: (r) =>
                        r.status === 200 ||
                        r.status === 204 ||
                        r.status === 409 ||
                        r.status === 422,
                });
            }
        } catch (e) {
            // JSON parse failed, skip
        }
    }

    sleep(0.3);

    // Read application form if exists
    if (comp.has_form) {
        const formRes = get(
            `/competitions/${comp.id}/application-form/`,
            comp.organizer_id,
        );
        check(formRes, {
            "form read": (r) => r.status === 200 || r.status === 404,
        });
    }

    sleep(0.3);

    // Update organizer profile (30% chance)
    if (Math.random() < 0.3) {
        const updateOrgRes = put(
            "/users/me/organizer",
            {
                organizer_name: `Updated Org ${Date.now().toString(36)}`,
                contact_email: `updated_org_${Date.now().toString(36)}@test.com`,
            },
            comp.organizer_id,
        );
        check(updateOrgRes, { "organizer updated": (r) => r.status === 200 });
    }

    sleep(0.3);

    // Reschedule competition (20% chance)
    if (Math.random() < 0.2) {
        const rescheduleRes = patch(
            `/competitions/${comp.id}/schedule`,
            {
                schedule: {
                    registration_start: futureDate(2),
                    registration_end: futureDate(35),
                },
                team_size: { min: 1, max: 5 },
            },
            comp.organizer_id,
        );
        check(rescheduleRes, {
            "competition rescheduled": (r) => r.status === 200,
        });
    }

    // Delete application form (10% chance, only if exists)
    if (comp.has_form && Math.random() < 0.1) {
        const deleteFormRes = del(
            `/competitions/${comp.id}/application-form/`,
            comp.organizer_id,
        );
        if (deleteFormRes.status === 200 || deleteFormRes.status === 204) {
            comp.has_form = false;
        }
        check(deleteFormRes, {
            "form deleted": (r) => r.status === 200 || r.status === 204,
        });
    }

    // Archive competition (10% chance)
    if (Math.random() < 0.1 && !comp.is_archived) {
        const archiveRes = patch(
            `/competitions/${comp.id}/archive-status`,
            { is_archived: true },
            comp.organizer_id,
        );
        if (archiveRes.status === 200) {
            comp.is_archived = true;
        }
        check(archiveRes, { "competition archived": (r) => r.status === 200 });
    }

    sleep(randomIntBetween(1, 3));
}

export function teardown(data) {
    console.log("=== TEARDOWN ===");
    console.log(`Total competitions in data: ${data.competitions.length}`);
}
