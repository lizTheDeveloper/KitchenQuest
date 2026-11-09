/** Pan triggers the game fires by name. The build fails if pan.yaml lacks any of them. */
export const REQUIRED_PAN_TRIGGERS: readonly string[] = [
  'greet.first_ever',
  'greet.morning',
  'greet.afternoon',
  'greet.evening',
  'greet.late_night',
  'greet.return_after_gap',
  'cook.start',
  'cook.step_quip',
  'cook.timer_start',
  'cook.timer_done',
  'cook.done',
  'travel.map_remark',
  'travel.depart',
  'ai_unavailable',
  'thanks',
  'intake.ios_home_screen',
  'voice.not_yet',
  'toolkit.rusty_invite',
];

/** Bureau disclaimers the recipe card shows. The build fails if forms.yaml lacks any of them. */
export const REQUIRED_DISCLAIMERS: readonly string[] = ['cross_contact', 'unverified'];
