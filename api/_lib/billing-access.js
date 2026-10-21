function billingAccess({ freeRemaining, creditBalance, comped, legacyMetered, blockedThisMonth }) {
  const needsCredits = !comped && !legacyMetered && creditBalance <= 0;
  return {
    limit_reached: needsCredits && freeRemaining === 0,
    request_blocked_this_month: needsCredits && Boolean(blockedThisMonth),
  };
}

module.exports = { billingAccess };
