import type {
  EmailTemplate,
  Lead,
  SenderAccount,
  SequenceSettings,
  SequenceStep,
  UserProfile,
} from "./types"

/** Sample leads (mirrors the inspiration screenshots). */
export const MOCK_LEADS: Lead[] = [
  {
    id: "l1",
    companyName: "thumpN",
    firstName: "Varun",
    lastName: "Khare",
    email: "varun@thumpn.com",
    personalizationLine: "your work on real-time agent orchestration",
    sendTimeIST: "10:00",
    jobTitle: "CEO",
    website: "https://thumpn.com",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l2",
    companyName: "Pie",
    firstName: "Akhil",
    lastName: "Mantripragada",
    email: "akhil@getpie.com",
    personalizationLine: "Pie's approach to underwriting automation",
    sendTimeIST: "11:30",
    jobTitle: "Co-Founder",
    website: "https://getpie.com",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l3",
    companyName: "Kapture CX",
    firstName: "Sanchit",
    lastName: "Sood",
    email: "sanchit@kapturecx.com",
    personalizationLine: "how Kapture is layering AI into CX workflows",
    sendTimeIST: "14:00",
    jobTitle: "Chief AI Officer",
    website: "https://kapturecx.com",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l4",
    companyName: "Lyzr",
    firstName: "Siva",
    lastName: "Surendira",
    email: "siva@lyzr.ai",
    personalizationLine: "Lyzr's agent framework",
    sendTimeIST: "15:30",
    jobTitle: "CEO",
    website: "https://lyzr.ai",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l5",
    companyName: "Prime Intellect",
    firstName: "Jannik",
    lastName: "Straube",
    email: "jannik@primeintellect.ai",
    personalizationLine: "distributed training at Prime Intellect",
    sendTimeIST: "18:00",
    jobTitle: "Founding Head of Engineering",
    website: "https://primeintellect.ai",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l6",
    companyName: "ESGAgent.ai",
    firstName: "Shan",
    lastName: "Kadavil",
    email: "shan@esgagent.ai",
    personalizationLine: "ESGAgent's compliance automation",
    sendTimeIST: "09:30",
    jobTitle: "Founder",
    website: "https://esgagent.ai",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l7",
    companyName: "Floqer",
    firstName: "Shivam",
    lastName: "Mahajan",
    email: "shivam@floqer.com",
    personalizationLine: "Floqer's workflow builder",
    sendTimeIST: "12:15",
    jobTitle: "Co-Founder & CEO",
    website: "https://floqer.com",
    verification: "not_verified",
    status: "draft",
  },
  {
    id: "l8",
    companyName: "Monorale AI",
    firstName: "Alex",
    lastName: "Wilkinson",
    email: "aw@monorale.com",
    personalizationLine: "Monorale's voice-agent stack",
    sendTimeIST: "16:45",
    jobTitle: "CEO",
    website: "https://monorale.com",
    verification: "not_verified",
    status: "draft",
  },
]

const OPENING_BODY = `<p>Hi {{first_name:"there"}},</p>
<p>{{personalization}}, closely matches the systems I've been building. I built a <a href="https://example.com/mf-agent">Mutual Funds Research Agent</a> with specialized tools for structured analysis. I also developed a <a href="https://example.com/confirmtkt-mcp">ConfirmTkt MCP Server</a> that provides live railway search and seat availability through a public API integration.</p>
<p>I work across <strong>MCP tooling, agent workflows, external integrations, and the product layer</strong> around them.</p>
<p>I'd love to discuss how my experience could contribute to {{company:"your company"}}'s AI engineering team.</p>
<p>Best,<br>Uditya Kumar Pandey<br><a href="https://linkedin.com/in/udityakumar">linkedin.com/in/udityakumar</a><br>+91 9953076454</p>`

/**
 * A fresh sequence for one recipient: opening → wait → follow-up → wait → follow-up.
 * Each lead gets its own copy so the content can be personalized per recipient.
 */
export function newSequenceForLead(leadId: string): SequenceStep[] {
  return [
    {
      id: `${leadId}-s1`,
      kind: "email",
      name: "Opening email",
      subject: 'Interested in building with {{company:"Company"}}',
      bodyHtml: OPENING_BODY,
    },
    { id: `${leadId}-s2`, kind: "delay", name: "Wait", waitDays: 3 },
    {
      id: `${leadId}-s3`,
      kind: "email",
      name: "Follow-up #1",
      subject: "",
      bodyHtml: "",
    },
    { id: `${leadId}-s4`, kind: "delay", name: "Wait", waitDays: 3 },
    {
      id: `${leadId}-s5`,
      kind: "email",
      name: "Follow-up #2",
      subject: "",
      bodyHtml: "",
    },
  ]
}

/** Saved sequence templates the user can apply to any recipient. */
export const MOCK_TEMPLATES: EmailTemplate[] = [
  {
    id: "t1",
    name: "AI engineering outreach",
    steps: newSequenceForLead("t1"),
  },
]

/** A blank template: one opening email, ready to be named and written. */
export function newTemplate(id: string): EmailTemplate {
  return {
    id,
    name: "Untitled template",
    steps: [
      {
        id: `${id}-s1`,
        kind: "email",
        name: "Opening email",
        subject: "",
        bodyHtml: "",
      },
    ],
  }
}

/**
 * Copy a template's steps for one recipient, re-keying every id so the recipient
 * owns their own editable copy (and two leads never share a step id).
 */
export function stepsFromTemplate(
  template: EmailTemplate,
  leadId: string
): SequenceStep[] {
  return template.steps.map((step, i) => ({
    ...step,
    id: `${leadId}-${template.id}-${i}`,
  }))
}

/** The logged-in owner. Independent of whatever Gmail is connected for sending. */
export const MOCK_PROFILE: UserProfile = {
  name: "Uditya Kumar",
  email: "uditya204@gmail.com",
}

export const MOCK_SENDERS: SenderAccount[] = [
  {
    id: "acc1",
    email: "uditya204@gmail.com",
    name: "Uditya Kumar",
    dailyLimit: 15,
    status: "active",
  },
]

export const DEFAULT_SETTINGS: SequenceSettings = {
  trackOpens: false,
  trackClicks: false,
  outreachDays: [0, 1, 2, 3], // Mon–Thu
  followUpDays: [0, 1, 2, 3, 4], // Mon–Fri
}
