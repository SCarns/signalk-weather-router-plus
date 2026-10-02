/** Errors the plugin's API layer maps to HTTP statuses by class. */

/** The plugin's services are not up (stopped, or still starting): HTTP 503. */
export class NotStartedError extends Error {
  constructor(message = 'plugin not started') {
    super(message);
    this.name = 'NotStartedError';
  }
}
