/**
 * returnConfigServer.js
 * Centraliza la lógica para el manejo de redirecciones y parámetros returnTo en el servidor (Node.js).
 */

const ReturnConfigServer = {
    /**
     * Obtiene la URL de redirección al login con el parámetro returnTo.
     * @param {Object} req - Objeto de solicitud de Express.
     * @returns {string} - URL de redirección.
     */
    getLoginRedirect: function(req) {
        const returnTo = encodeURIComponent(req.originalUrl);
        return `/login?returnTo=${returnTo}`;
    },

    /**
     * Obtiene la ruta de redirección final después del login.
     * @param {string} returnTo - Parámetro returnTo de la solicitud.
     * @param {string} defaultPath - Ruta por defecto si no hay returnTo.
     * @returns {string} - Ruta de redirección.
     */
    getFinalRedirectPath: function(returnTo, defaultPath = '/actividad') {
        if (returnTo && returnTo !== 'undefined' && returnTo !== 'null') {
            // Validar que sea una ruta relativa para evitar redirecciones abiertas
            if (returnTo.startsWith('/') && !returnTo.includes('//')) {
                return returnTo;
            }
        }
        return defaultPath;
    },

    /**
     * Obtiene la URL de verificación con el parámetro returnTo.
     * @param {string} redirectPath - Ruta a la que se debe redirigir después de verificar.
     * @returns {string} - URL de verificación.
     */
    getVerifyRedirect: function(redirectPath) {
        return `/verify?returnTo=${encodeURIComponent(redirectPath)}`;
    }
};

export default ReturnConfigServer;
