/** Prefix Jupyter AI assigns to persona usernames (`BasePersona.id`). */
export const PERSONA_USERNAME_PREFIX = 'jupyter-ai-personas::';

/** Whether a chat user is an agent rather than a person. */
export function isPersonaUser(user: {
  username: string;
  bot?: boolean;
}): boolean {
  return user.bot === true || user.username.startsWith(PERSONA_USERNAME_PREFIX);
}
