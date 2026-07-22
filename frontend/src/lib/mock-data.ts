import type {
  Lead,
  SenderAccount,
  SequenceSettings,
  SequenceStep,
} from "./types"

/** Sample leads (mirrors the inspiration screenshots). */
export const MOCK_LEADS: Lead[] = [
  {
    id: "l1",
    companyName: "thumpN",
    contactFullName: "Varun Khare",
    email: "varun@thumpn.com",
    personalizationLine: "your work on real-time agent orchestration",
    sendTimeIST: "10:00",
    jobTitle: "CEO",
    website: "https://thumpn.com",
    verification: "not_verified",
  },
  {
    id: "l2",
    companyName: "Pie",
    contactFullName: "Akhil Mantripragada",
    email: "akhil@getpie.com",
    personalizationLine: "Pie's approach to underwriting automation",
    sendTimeIST: "11:30",
    jobTitle: "Co-Founder",
    website: "https://getpie.com",
    verification: "not_verified",
  },
  {
    id: "l3",
    companyName: "Kapture CX",
    contactFullName: "Sanchit Sood",
    email: "sanchit@kapturecx.com",
    personalizationLine: "how Kapture is layering AI into CX workflows",
    sendTimeIST: "14:00",
    jobTitle: "Chief AI Officer",
    website: "https://kapturecx.com",
    verification: "not_verified",
  },
  {
    id: "l4",
    companyName: "Lyzr",
    contactFullName: "Siva Surendira",
    email: "siva@lyzr.ai",
    personalizationLine: "Lyzr's agent framework",
    sendTimeIST: "15:30",
    jobTitle: "CEO",
    website: "https://lyzr.ai",
    verification: "not_verified",
  },
  {
    id: "l5",
    companyName: "Prime Intellect",
    contactFullName: "Jannik Straube",
    email: "jannik@primeintellect.ai",
    personalizationLine: "distributed training at Prime Intellect",
    sendTimeIST: "18:00",
    jobTitle: "Founding Head of Engineering",
    website: "https://primeintellect.ai",
    verification: "not_verified",
  },
  {
    id: "l6",
    companyName: "ESGAgent.ai",
    contactFullName: "Shan Kadavil",
    email: "shan@esgagent.ai",
    personalizationLine: "ESGAgent's compliance automation",
    sendTimeIST: "09:30",
    jobTitle: "Founder",
    website: "https://esgagent.ai",
    verification: "not_verified",
  },
  {
    id: "l7",
    companyName: "Floqer",
    contactFullName: "Shivam Mahajan",
    email: "shivam@floqer.com",
    personalizationLine: "Floqer's workflow builder",
    sendTimeIST: "12:15",
    jobTitle: "Co-Founder & CEO",
    website: "https://floqer.com",
    verification: "not_verified",
  },
  {
    id: "l8",
    companyName: "Monorale AI",
    contactFullName: "Alex Wilkinson",
    email: "aw@monorale.com",
    personalizationLine: "Monorale's voice-agent stack",
    sendTimeIST: "16:45",
    jobTitle: "CEO",
    website: "https://monorale.com",
    verification: "not_verified",
  },
]

const OPENING_BODY = `<p>Hi {{first_name:"there"}},</p>
<p>{{personalization}}, closely matches the systems I've been building. I built a <a href="https://example.com/mf-agent">Mutual Funds Research Agent</a> with specialized tools for structured analysis. I also developed a <a href="https://example.com/confirmtkt-mcp">ConfirmTkt MCP Server</a> that provides live railway search and seat availability through a public API integration.</p>
<p>I work across <strong>MCP tooling, agent workflows, external integrations, and the product layer</strong> around them.</p>
<p>I'd love to discuss how my experience could contribute to {{company:"your company"}}'s AI engineering team.</p>
<p>Best,<br>Uditya Kumar Pandey<br><a href="https://linkedin.com/in/udityakumar">linkedin.com/in/udityakumar</a><br>+91 9953076454</p>`

/** Sample sequence: opening → wait → follow-up → wait → follow-up. */
export const MOCK_SEQUENCE: SequenceStep[] = [
  {
    id: "s1",
    kind: "email",
    name: "Opening email",
    subject: 'Interested in building with {{company:"Company"}}',
    bodyHtml: OPENING_BODY,
    abTest: false,
  },
  { id: "s2", kind: "delay", name: "Wait", waitDays: 3 },
  {
    id: "s3",
    kind: "email",
    name: "Follow-up #1",
    subject: "",
    bodyHtml: "",
    abTest: false,
  },
  { id: "s4", kind: "delay", name: "Wait", waitDays: 3 },
  {
    id: "s5",
    kind: "email",
    name: "Follow-up #2",
    subject: "",
    bodyHtml: "",
    abTest: false,
  },
]

export const MOCK_SENDERS: SenderAccount[] = [
  {
    id: "acc1",
    email: "uditya204@gmail.com",
    name: "Uditya Kumar",
    status: "needs_protection",
    provider: "Gmail",
    allocatedRecipients: 17,
    sentToday: 0,
    dailyLimit: 15,
  },
]

export const DEFAULT_SETTINGS: SequenceSettings = {
  trackOpens: false,
  trackClicks: false,
  bccEnabled: false,
  bccAddress: "",
  sendingDays: [0, 1, 2, 3, 4], // Mon–Fri
  sendWindowStart: "09:00",
  sendWindowEnd: "17:00",
  startOnSpecificDay: false,
  startDate: "",
}
