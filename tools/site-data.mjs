/**
 * Single source of truth for site chrome and per-page metadata.
 *
 * Before this file, the nav was copy-pasted into 51 pages and had drifted into
 * 8 variants; titles were 1-2 generic words with 6 collisions; and no page had
 * a meta description. tools/retheme.mjs renders everything here into every page.
 *
 * Paths are ROOT-RELATIVE on purpose ("/pages/faq.html", not "../pages/faq.html").
 * The site is served at the domain root, and relative paths are what broke every
 * link in pages/GOV SHUTDOWN/ when those files were moved one level deeper.
 */

export const SITE = {
  name: 'PARC Radio & Technology',
  short: 'PARC',
  /* Override per build so canonical tags, Open Graph URLs and the sitemap all
     name the host actually serving the page:
        SITE_ORIGIN=https://radiotests.org node tools/deploy.mjs
     A canonical pointing at a different host tells search engines that host has
     the real version — which is wrong, and actively harmful when that host is
     serving different content. */
  origin: process.env.SITE_ORIGIN || 'https://parcradio.net',
  tagline: 'Amateur radio license exams, online and in person.',
  email: 'vetesting@yahoo.com',
  veEmail: 've@parcradio.org',
  address: { po: 'PO Box 926', city: 'Roanoke', state: 'AL', zip: '36274-0926', country: 'USA' },
  facebook: 'https://www.facebook.com/groups/833919518104689',
  paypalButton: 'FG837WNAHF4P4',
  banner: '/images/banner-1600.jpg',
  bannerMobile: '/images/banner-900.jpg',
  ogImage: '/images/og-parc.jpg',
  // Paste the token from Search Console -> Settings -> Ownership verification.
  googleSiteVerification: '',

  /* Cloudflare Web Analytics, one token per site.
     Deliberately this and not Google Analytics: the schedule page asks minors
     for a date of birth, so anything that sets cookies or builds a cross-site
     profile is the wrong tool here. Cloudflare Web Analytics is cookieless,
     stores no personal data, and needs no consent banner.
     Get a token at: Cloudflare dash -> Web Analytics -> Add a site.

     Keyed by hostname because the same source builds several domains, and a
     token is what tells Cloudflare which site a hit belongs to. Shipping one
     domain's token from another silently merges their traffic into one graph,
     which is the exact comparison this is here to make possible.

     These are NOT secrets. Each ships in the HTML of every page it builds and
     is readable in View Source. Worker secrets are the opposite - see DEPLOY.md. */
  analyticsTokens: {
    'radiotests.org': '9ba7325d05ee4c318c7d359aefcac7a8',
    'parcradio.net':  'a3f57bbf8cf048d69b86140eb93c297d',
    'parcradio.org':  '86375f5cd0ea45a9a9083404b92011b6',
  },

  /* Resolved from origin, so a build cannot emit the wrong site's token.
     An unlisted host yields '' and the beacon is simply omitted, which is the
     safe failure: no analytics beats attributing this site's traffic to another.
     ANALYTICS_TOKEN=... overrides for a one-off build; ANALYTICS_TOKEN= (empty)
     disables it. */
  get analyticsToken() {
    if (process.env.ANALYTICS_TOKEN !== undefined) return process.env.ANALYTICS_TOKEN;
    let host;
    try { host = new URL(this.origin).hostname.replace(/^www\./, ''); }
    catch { return ''; }
    return this.analyticsTokens[host] || '';
  },
};

export const NAV = [
  { label: 'Home', href: '/index.html' },
  {
    label: 'Helpful Links',
    children: [
      { label: "What's Next", href: '/pages/whatnext.html' },
      { label: 'Accessible Testing / HandiHam', href: '/pages/handiham.html' },
      { label: 'Government Shutdown', href: '/pages/govshutdown.html' },
      { label: 'ARRL', href: 'https://www.arrl.org', external: true },
      { label: 'eHam', href: 'https://www.eham.net', external: true },
      { label: 'FCC License Search', href: 'https://wireless2.fcc.gov', external: true },
      { label: 'Ham Radio Prep', href: 'https://hamradioprep.com', external: true },
      { label: 'HandiHam.org', href: 'https://www.handiham.org', external: true },
      { label: 'QRZ', href: 'https://www.qrz.com', external: true },
      { label: 'Young Ladies Radio League', href: 'https://www.ylrl.net', external: true },
    ],
  },
  { label: 'Online Testing', href: '/pages/Online_InstructionSeparation.html' },
  { label: 'In-Person Testing', href: '/pages/inperson.html' },
  { label: 'FAQ', href: '/pages/faq.html' },
  { label: 'Schedule', href: '/pages/calendar.html' },
  { label: 'Reviews', href: '/pages/reviews.html' },
  { label: 'Our Team', href: '/pages/team.html' },
];

/** Pages encrypted by tools/parc-lock.mjs. Their shells are always noindex. */
export const VE_PAGES = [
  /* Not an exam script — the form that puts a VE on the public team page. It is
     locked so that only people who already hold the VE passcode can submit one. */
  'pages/team-submit.html',
  'pages/script.html', 'pages/script2.html', 'pages/scriptnospace.html',
  'pages/scriptupdate.html', 'pages/easyread.html', 'pages/oldscript.html',
  'pages/ScriptBreakOutPreRead.html', 'pages/Online_MainRoomSetupScript.html',
  'pages/Online_ScriptD.html', 'pages/Online_ScriptF.html', 'pages/Online_ScriptI.html',
  'pages/Online_ScriptI2.html', 'pages/Online_ScriptR.html', 'pages/Online_ScriptS.html',
  'pages/Online_ScriptS2.html', 'pages/Online_ScriptW5YI.html', 'pages/Online_ScriptZ.html',
  'pages/Online_SetupSheet_IS.html',
];

/** Deleted by the retheme pass: orphaned duplicates with broken relative paths. */
export const DELETE_PAGES = [
  'pages/waitlist.html',      // waitlist retired — candidates email instead
  'pages/GOV SHUTDOWN/script2.html',
  'pages/GOV SHUTDOWN/Online_ScriptI2.html',
  'pages/GOV SHUTDOWN/Online_ScriptS2.html',
  'pages/Update/script.html',
  'pages/Online_AcceptableID.html', // zero-inbound duplicate of pages/ID.html
];

/**
 * Titles are kept under ~60 characters so Google doesn't truncate them, and are
 * written around what candidates actually search for rather than what the page
 * is called internally. Descriptions run ~150-160 characters.
 */
export const PAGES = {
  'index.html': {
    title: 'Amateur Radio License Exams — Online & In-Person',
    desc: 'PARC Radio & Technology gives amateur radio license exams online and in person. All-volunteer examiners, sessions most days, Technician through Extra.',
    h1: 'Amateur Radio License Exams, Online and In Person',
    schema: 'organization',
  },
  'pages/calendar.html': {
    // Extra scripts belong HERE, not patched in after retheme runs. Anything
    // added to the built page by hand is silently discarded the next time
    // retheme regenerates it — which is exactly how schedule.js went missing
    // and broke the whole schedule page.
    scripts: ['/js/schedule.js'],
    title: 'Schedule a Ham Radio License Exam',
    desc: 'Book your amateur radio license exam. Sessions run throughout the day and night — pick a time that works and reserve your seat online.',
    h1: 'Schedule Your Exam',
    schema: 'events',
  },
  'pages/faq.html': {
    title: 'Ham Radio Exam FAQ — Your Questions Answered',
    desc: 'Answers to the questions candidates ask most about online and in-person amateur radio license exams: fees, ID, equipment, rules, and results.',
    h1: 'Frequently Asked Questions',
    schema: 'faq',
  },
  'pages/inperson.html': {
    title: 'In-Person Ham Radio Exams — Roanoke & Auburn, AL',
    desc: 'PARC gives in-person amateur radio license exams in Roanoke and Auburn, Alabama, plus other locations when published or by request.',
    h1: 'In-Person Exam Sessions',
  },
  'pages/online.html': {
    title: 'Online Ham Radio Exam — What You Need to Know',
    desc: 'Everything required for a remote video amateur radio exam with PARC. Read all instructions and requirements before paying or registering.',
    h1: 'Ham Exam — Online',
  },
  'pages/Online_InstructionSeparation.html': {
    title: 'Online Amateur Radio Exam Instructions',
    desc: 'Step-by-step instructions for taking your amateur radio license exam online with PARC: scheduling, preparation, rules, ID, and exam day.',
    h1: 'Online Testing Instructions',
  },
  'pages/whatnext.html': {
    title: "What's Next After Passing Your Ham Radio Exam",
    desc: 'You passed — now what? Getting your call sign, paying the FCC fee, finding a club, and the first steps on the air as a new amateur radio operator.',
    h1: "What's Next — Welcome to Amateur Radio",
  },
  'pages/govshutdown.html': {
    title: 'FCC Fees & Licensing During a Government Shutdown',
    desc: 'How a federal government shutdown affects FCC CORES payments, application processing, and your new amateur radio license or upgrade.',
    h1: 'Licensing During a Government Shutdown',
  },
  'pages/handiham.html': {
    title: 'Accessible Ham Radio Exams & HandiHam Support',
    desc: 'Amateur radio is for everyone. Accessible exam options, adaptive equipment, and study resources for blind, deaf, and physically disabled candidates.',
    h1: 'Amateur Radio for People with Disabilities',
  },
  'pages/ID.html': {
    title: 'Acceptable Photo ID for Your Ham Radio Exam',
    desc: 'Which forms of photo identification PARC accepts at an amateur radio license exam, and what to bring if you do not have a driver license.',
    h1: 'Acceptable Identification',
  },
  'pages/Online_GeneralInfo.html': {
    title: 'Online Exam General Information',
    desc: 'General information about PARC remote video amateur radio exam sessions: how they work, what to expect, and what is required of candidates.',
    h1: 'General Information',
  },
  'pages/Online_HowtoScheduleandRegister.html': {
    title: 'How to Schedule and Register for Your Exam',
    desc: 'How to book an amateur radio exam session with PARC and complete registration, for single candidates, multiple exams, and groups.',
    h1: 'How to Schedule and Register',
  },
  'pages/Online_WhereandHowtoStudy.html': {
    title: 'Where and How to Study for Your Ham Radio Exam',
    desc: 'Free and paid study resources for the Technician, General, and Extra amateur radio exams, plus practice tests and how to use them well.',
    h1: 'Where and How to Study',
  },
  'pages/Online_Preparation.html': {
    title: 'Preparing for Your Online Ham Radio Exam',
    desc: 'What to set up before your remote amateur radio exam: the room, your computer, a second device, acceptable ID, and the rules you must follow.',
    h1: 'Preparation',
  },
  'pages/Online_Prep_Room.html': {
    title: 'Exam Room Requirements for Online Testing',
    desc: 'How your room must be arranged for a remote amateur radio exam — lighting, walls, desk, and what has to be cleared before the session starts.',
    h1: 'Preparing Your Room',
  },
  'pages/Online_Prep_Computer.html': {
    title: 'Computer Setup for Your Online Ham Radio Exam',
    desc: 'How to prepare your computer for a remote amateur radio exam: Zoom, screen sharing, closing programs, and testing your camera and microphone.',
    h1: 'Preparing Your Computer',
  },
  'pages/Online_Prep_2ndDevice.html': {
    title: 'Second Device Setup for Online Exams',
    desc: 'Your remote amateur radio exam needs a second camera device. How to position a phone or tablet so examiners can see your whole workspace.',
    h1: 'Preparing Your Second Device',
  },
  'pages/Online_Protocol.html': {
    title: 'Online Exam Protocol and Procedures',
    desc: 'The protocol PARC volunteer examiners follow during a remote amateur radio exam, and what candidates are expected to do at each step.',
    h1: 'Exam Protocol',
  },
  'pages/Online_Rules_IR.html': {
    title: 'Online Ham Radio Exam Rules',
    desc: 'The rules every candidate agrees to for a remote amateur radio license exam with PARC, and what will end a session early.',
    h1: 'Exam Rules',
  },
  'pages/Online_Rules_IQ.html': {
    title: 'Online Exam Rules and Requirements',
    desc: 'Requirements and conduct rules for PARC remote amateur radio exam sessions, including the prohibited applications list.',
    h1: 'Rules and Requirements',
  },
  'pages/Online_SingleExam.html': {
    title: 'Scheduling a Single Ham Radio Exam',
    desc: 'How to book one amateur radio exam element with PARC — the standard path for most candidates taking Technician, General, or Extra.',
    h1: 'Single Exam',
  },
  'pages/Online_MultiExam.html': {
    title: 'Taking Multiple Exam Elements in One Session',
    desc: 'You may attempt Technician, General, and Extra in a single sitting. How PARC handles multi-element amateur radio exam sessions.',
    h1: 'Multiple Exams',
  },
  'pages/Online_MultiCandidate.html': {
    title: 'Scheduling Multiple Candidates',
    desc: 'How families, clubs, classes, and scout groups book several amateur radio exam candidates into one PARC session.',
    h1: 'Multiple Candidates',
  },
  'pages/Online_Handicapped.html': {
    title: 'Exam Accommodations for Candidates with Disabilities',
    desc: 'PARC provides accommodations for amateur radio exam candidates with disabilities, including readers, extra time, and adaptive setups.',
    h1: 'Accommodations',
  },
  'pages/Online_CSCE_605.html': {
    title: 'Your CSCE and FCC Form 605 Explained',
    desc: 'What the CSCE you receive after passing means, how FCC Form 605 fits in, and what happens between your exam and your call sign.',
    h1: 'CSCE and FCC Form 605',
  },
  'pages/reviews.html': {
    scripts: ['/js/reviews.js'],
    title: 'Reviews — What Candidates Say About PARC',
    desc: 'Read what candidates say about taking their amateur radio license exam with PARC, and leave a review of your own session.',
    h1: 'Reviews',
  },
  'pages/troubleshooting.html': {
    title: 'If Something Goes Wrong — Exam Day Troubleshooting',
    desc: 'The problems candidates hit most often before and during an online amateur radio exam, and what to do about each one.',
    h1: 'If something goes wrong',
  },
  'pages/team.html': {
    scripts: ['/js/team.js'],
    title: 'Our Team — The Volunteer Examiners at PARC',
    desc: 'Meet the volunteer examiners who run PARC exam sessions almost every day of the week.',
    h1: 'Our Team',
  },
  'pages/donations.html': {
    title: 'Support PARC Radio & Technology',
    desc: 'PARC is an all-volunteer group. Donations cover exam materials, equipment, and community outreach — none of it pays a salary.',
    h1: 'Support Our Work',
  },
  'pages/payhere.html': {
    title: 'Pay Your Exam Fee',
    desc: 'Pay the amateur radio exam application fee for your scheduled PARC session. Use the same email address you used to schedule.',
    h1: 'Pay Your Exam Fee',
    noindex: true, // transactional; nothing to gain from indexing
  },
  '404.html': {
    title: 'Page Not Found',
    desc: '',
    noindex: true,
  },
  'pages/ve-file.html': {
    scripts: ['/js/ve-file.js'],
    title: 'Volunteer Examiner Access',
    desc: '',
    noindex: true,
  },
};

/** Real titles, applied by js/ve-lock.js only AFTER a successful unlock. The
 *  locked shell shows a generic title so the URL alone doesn't reveal which
 *  script sits behind it. */
export const VE_TITLES = {
  'team-submit.html': 'Add Yourself to the Team Page',
  'script.html': 'Single Room Script',
  'script2.html': 'Single Room Script (Shutdown)',
  'scriptnospace.html': 'Single Room Script — No Space',
  'scriptupdate.html': 'Single Room Script — Update',
  'easyread.html': 'Easy Read Script',
  'oldscript.html': 'Old Script',
  'ScriptBreakOutPreRead.html': 'Break Out Room Pre-Read',
  'Online_MainRoomSetupScript.html': 'Main Room Setup Script',
  'Online_ScriptD.html': 'Break Out Room Delta (D)',
  'Online_ScriptF.html': 'Break Out Room Foxtrot (F)',
  'Online_ScriptI.html': 'Break Out Room India (I)',
  'Online_ScriptI2.html': 'Break Out Room India (I) — Shutdown',
  'Online_ScriptR.html': 'Break Out Room Romeo (R)',
  'Online_ScriptS.html': 'Break Out Room Sierra (S)',
  'Online_ScriptS2.html': 'Break Out Room Sierra (S) — Shutdown',
  'Online_ScriptW5YI.html': 'W5YI Script',
  'Online_ScriptZ.html': 'Break Out Room Zulu (Z)',
  'Online_SetupSheet_IS.html': 'Setup Sheet',
};

/** Every VE unlock shell gets this. The real title is restored by js/ve-lock.js
 *  after a successful unlock, so the locked page never advertises which script
 *  it holds to anyone who happens across the URL. */
export const VE_SHELL_META = {
  title: 'Volunteer Examiner Access',
  desc: '',
  noindex: true,
};
